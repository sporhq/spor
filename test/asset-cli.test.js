// asset-cli.test.js — `spor asset import|describe|fetch|verify`
// (task-spor-chatgpt-asset-cli). The pure contracts in lib/kernel/content.js
// (sniffing, the truncation check, the canonical descriptor text, the safe
// filename), the local content-addressed store, and the remote byte routes
// against an in-file stub of POST /v1/assets + GET /v1/assets/:id[/content].
//
// The stub measures with the client's own kernel (like stub-spor-server.js), so
// it pins what the CLIENT sends and does with the answers — query-string
// metadata, the Idempotency-Key, the retry after a reset, verification of the
// served bytes. Against the REAL server the descriptor text is pinned by
// DESCRIPTOR_GOLDEN below, captured from spor-server's upload door (92a8e4f+)
// for the same image and metadata, its write-door stamps (author/authored_via/
// created_by/date) set aside.
// Never the live graph: scratch homes only, hermetic env.

require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { hermeticEnv } = require("./helpers/env.js");
const { gitEnv } = require("./helpers/git.js");
const content = require("../lib/kernel/content.js");
const assetLib = require("../lib/shell/asset.js");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

// --- fixtures ---------------------------------------------------------------

function crc32(b) {
  let crc = -1;
  for (const x of b) {
    let c = (crc ^ x) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
}
// A real w×h RGB PNG (stored deflate, so the bytes are deterministic).
function png(w, h, seed = 7) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let i = 0; i < raw.length; i++) raw[i] = i % (w * 3 + 1) === 0 ? 0 : (i * seed) & 0xff;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
const sha = (b) => `sha256:${crypto.createHash("sha256").update(b).digest("hex")}`;

const SAMPLE = png(64, 48);

// The real server's descriptor for SAMPLE imported with --title "Smoke" --alt
// "A test: image", minus its write-door stamps.
const DESCRIPTOR_GOLDEN = (id, digest) => [
  "---",
  `id: ${id}`,
  "type: artifact",
  'title: "Smoke"',
  `summary: "Uploaded PNG image, 64×48 px, ${SAMPLE.length} bytes: A test: image"`,
  `asset_digest: ${digest}`,
  "asset_media_type: image/png",
  `asset_bytes: ${SAMPLE.length}`,
  "asset_width: 64",
  "asset_height: 48",
  'asset_alt: "A test: image"',
  "---",
  "",
  `Asset descriptor for a PNG image, 64×48 px, ${SAMPLE.length} bytes. The bytes live outside graph Git, content-addressed by \`${digest}\`.`,
  "",
  "Caption: A test: image",
  "",
  `Embed it in a markdown document as \`![caption](spor-asset:${id}@${digest})\`.`,
  "",
].join("\n");

function scratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(args, { env = {}, cwd } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: hermeticEnv({ SPOR_ENABLED: "1", ...env }), cwd: cwd || os.tmpdir() });
    const out = [];
    const errb = [];
    c.stdout.on("data", (d) => out.push(d));
    c.stderr.on("data", (d) => errb.push(d));
    c.on("close", (status) => resolve({ status, stdoutBuf: Buffer.concat(out), stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(errb).toString("utf8") }));
  });
}

async function localHome() {
  const home = scratch("spor-asset-home-");
  const r = await run(["init"], { env: { SPOR_HOME: home, ...gitEnv({}, {}) } });
  assert.strictEqual(r.status, 0, r.stderr);
  return home;
}

function stripStamps(raw) {
  return raw.replace(/^(date|author|authored_via|created_by): .*\n/gm, "");
}

// --- kernel -----------------------------------------------------------------

test("kernel: sniffImage reads PNG/GIF/JPEG/WebP headers and refuses everything else", () => {
  assert.deepStrictEqual(content.sniffImage(SAMPLE), { media_type: "image/png", width: 64, height: 48 });
  const gif = Buffer.from("GIF89a\x0a\x00\x05\x00", "latin1");
  assert.deepStrictEqual(content.sniffImage(gif), { media_type: "image/gif", width: 10, height: 5 });
  // JPEG: SOI, an APP0 segment, then SOF0 with 3x2.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x03, 0x01]);
  assert.deepStrictEqual(content.sniffImage(jpeg), { media_type: "image/jpeg", width: 3, height: 2 });
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "latin1");
  webp.write("WEBPVP8X", 8, "latin1");
  webp.writeUIntLE(99, 24, 3);
  webp.writeUIntLE(49, 27, 3);
  assert.deepStrictEqual(content.sniffImage(webp), { media_type: "image/webp", width: 100, height: 50 });
  assert.strictEqual(content.sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null, "SVG is never an image here");
  assert.strictEqual(content.sniffImage(Buffer.from("GIF89a\x00\x00\x05\x00", "latin1")), null, "a zero dimension is no image");
});

test("kernel: assetTrailerError catches a truncated stream", () => {
  const info = content.sniffImage(SAMPLE);
  const tail = SAMPLE.subarray(SAMPLE.length - 16);
  assert.strictEqual(content.assetTrailerError(info, SAMPLE, tail, SAMPLE.length), null);
  const cut = SAMPLE.subarray(0, SAMPLE.length - 3);
  assert.match(content.assetTrailerError(info, cut, cut.subarray(cut.length - 16), cut.length), /truncated or corrupt/);
});

test("kernel: assetFilename is built from the id and a fixed extension table only", () => {
  const d = sha(SAMPLE);
  assert.strictEqual(content.assetFilename("art-asset-1", d, "image/png"), "art-asset-1.png");
  assert.strictEqual(content.assetFilename("art-asset-1", d, "image/jpeg"), "art-asset-1.jpg");
  assert.strictEqual(content.assetFilename("../../etc/passwd", d, "image/png"), `asset-${d.slice(7, 23)}.png`);
  assert.strictEqual(content.assetFilename("art-x", d, "text/html"), "art-x.bin");
});

test("kernel: normalizeAssetMeta refuses what the server's door refuses", () => {
  const ok = content.normalizeAssetMeta({ key: "key-00000001", title: "  T  " });
  assert.strictEqual(ok.title, "T");
  assert.strictEqual(ok.id, content.assetDescriptorId("local", "key-00000001"));
  assert.match(ok.id, /^art-asset-[0-9a-f]{16}$/);
  assert.throws(() => content.normalizeAssetMeta({ key: "short" }), /idempotency key/);
  assert.throws(() => content.normalizeAssetMeta({ key: "key-00000001", title: "a\nproject: evil" }), /single line/);
  assert.throws(() => content.normalizeAssetMeta({ key: "key-00000001", alt: "x y" }), /single line/);
  assert.throws(() => content.normalizeAssetMeta({ key: "key-00000001", title: "x".repeat(201) }), /over 200/);
  assert.throws(() => content.normalizeAssetMeta({ key: "key-00000001", id: "Bad_Id" }), /bad descriptor id/);
  assert.throws(() => content.normalizeAssetMeta({ key: "key-00000001", project: "../x" }), /bad project/);
  assert.throws(() => content.normalizeAssetMeta({ key: "key-00000001", digest: "md5:x" }), /sha256/);
});

test("kernel: assetDescriptorText matches the server's descriptor byte-for-byte and validates", () => {
  const digest = sha(SAMPLE);
  const meta = content.normalizeAssetMeta({ key: "key-00000001", id: "art-asset-golden", title: "Smoke", alt: "A test: image" });
  const raw = content.assetDescriptorText(meta, { digest, size: SAMPLE.length, media_type: "image/png", width: 64, height: 48 });
  assert.strictEqual(raw, DESCRIPTOR_GOLDEN("art-asset-golden", digest));
  const fm = require("../lib/graph.js").parseFrontmatter(raw, "art-asset-golden.md");
  assert.deepStrictEqual(content.validateContentFields(fm), []);
  assert.strictEqual(content.assetDescriptor(fm).digest, digest);
  // A caption cannot inject a frontmatter line: it is JSON-quoted.
  const evil = content.assetDescriptorText(
    content.normalizeAssetMeta({ key: "key-00000001", title: 'x" \\nproject: evil' }),
    { digest, size: 1, media_type: "image/png", width: 1, height: 1 },
  );
  assert.doesNotMatch(evil, /^project: evil$/m);
});

test("shell: measure refuses non-images, pixel bombs, truncation and a wrong declared digest", async () => {
  const one = (b) => [b];
  await assert.rejects(assetLib.measure(one(Buffer.from("hello world, not an image"))), { code: "unsupported_media" });
  await assert.rejects(assetLib.measure(one(SAMPLE), { maxPixels: 100 }), { code: "too_many_pixels" });
  await assert.rejects(assetLib.measure(one(SAMPLE), { maxBytes: 10 }), { code: "too_large" });
  await assert.rejects(assetLib.measure(one(SAMPLE.subarray(0, SAMPLE.length - 1))), { code: "malformed_image" });
  await assert.rejects(assetLib.measure(one(SAMPLE), { expectedDigest: sha(Buffer.from("x")) }), { code: "digest_mismatch" });
  const m = await assetLib.measure([SAMPLE.subarray(0, 10), SAMPLE.subarray(10)]);
  assert.deepStrictEqual(m, { digest: sha(SAMPLE), size: SAMPLE.length, media_type: "image/png", width: 64, height: 48 });
});

// --- local mode ---------------------------------------------------------------

test("local: import -> describe -> verify -> fetch round-trips byte-identical, private and idempotent", async () => {
  const home = await localHome();
  const work = scratch("spor-asset-work-");
  const src = path.join(work, "secret-name-screenshot.png");
  fs.writeFileSync(src, SAMPLE);
  const env = { SPOR_HOME: home };

  const imp = await run(["asset", "import", src, "--title", "Smoke", "--alt", "A test: image", "--json"], { env });
  assert.strictEqual(imp.status, 0, imp.stderr);
  const r = JSON.parse(imp.stdout);
  assert.strictEqual(r.status, "created");
  const id = r.asset.id;
  assert.strictEqual(r.embed, `![A test: image](${r.asset.uri})`);
  assert.match(id, /^art-asset-[0-9a-f]{16}$/);
  assert.deepStrictEqual(
    { digest: r.asset.digest, media_type: r.asset.media_type, bytes: r.asset.bytes, width: r.asset.width, height: r.asset.height },
    { digest: sha(SAMPLE), media_type: "image/png", bytes: SAMPLE.length, width: 64, height: 48 },
  );

  // Canonical text, a create-time date, and no trace of the source path.
  const raw = fs.readFileSync(path.join(home, "nodes", `${id}.md`), "utf8");
  assert.strictEqual(stripStamps(raw), DESCRIPTOR_GOLDEN(id, sha(SAMPLE)));
  assert.match(raw, /^date: \d{4}-\d{2}-\d{2}$/m);
  assert.doesNotMatch(raw, /secret-name|spor-asset-work/);

  // Bytes: content-addressed, read-only, outside graph Git.
  const obj = assetLib.objectPath(home, sha(SAMPLE));
  assert.ok(fs.readFileSync(obj).equals(SAMPLE));
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(obj).mode & 0o777, 0o444);
  assert.match(fs.readFileSync(path.join(home, ".git", "info", "exclude"), "utf8"), /^\/assets\/$/m);
  const st = spawnSync("git", ["-C", home, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", env: gitEnv() });
  assert.doesNotMatch(st.stdout, /assets\//);
  assert.strictEqual((await run(["validate"], { env })).status, 0);

  // Same image + metadata: the same descriptor, replayed.
  const again = await run(["asset", "import", src, "--title", "Smoke", "--alt", "A test: image", "--json"], { env });
  assert.strictEqual(again.status, 0, again.stderr);
  assert.strictEqual(JSON.parse(again.stdout).status, "replayed");
  assert.strictEqual(JSON.parse(again.stdout).asset.id, id);

  const desc = await run(["asset", "describe", id, "--json"], { env });
  assert.strictEqual(desc.status, 0, desc.stderr);
  const d = JSON.parse(desc.stdout);
  assert.strictEqual(d.available, true);
  assert.deepStrictEqual(
    { alt: d.asset.alt, title: d.asset.title, uri: d.asset.uri },
    { alt: "A test: image", title: "Smoke", uri: `spor-asset:${id}@${sha(SAMPLE)}` },
  );

  const ver = await run(["asset", "verify", `spor-asset:${id}@${sha(SAMPLE)}`], { env });
  assert.strictEqual(ver.status, 0, ver.stderr);
  assert.match(ver.stdout, /^verified /);

  const out = scratch("spor-asset-out-");
  const f = await run(["asset", "fetch", id, "--out", out], { env });
  assert.strictEqual(f.status, 0, f.stderr);
  assert.ok(fs.readFileSync(path.join(out, `${id}.png`)).equals(SAMPLE));
  const twice = await run(["asset", "fetch", id, "--out", out], { env });
  assert.strictEqual(twice.status, 1);
  assert.match(twice.stderr, /already exists/);
  assert.strictEqual((await run(["asset", "fetch", id, "--out", out, "--force"], { env })).status, 0);
  const piped = await run(["asset", "fetch", id, "--out", "-"], { env });
  assert.strictEqual(piped.status, 0, piped.stderr);
  assert.ok(piped.stdoutBuf.equals(SAMPLE));
  const nodir = await run(["asset", "fetch", id, "--out", path.join(out, "missing", "x.png"), "--json"], { env });
  assert.strictEqual(nodir.status, 1);
  assert.strictEqual(JSON.parse(nodir.stdout).error.code, "bad_request");
  assert.doesNotMatch(nodir.stdout, /\.part/);

  // A caption edited after the import does not turn the same import into a
  // conflict: the upload journal answers the replay, as the server's does.
  const nodeFile = path.join(home, "nodes", `${id}.md`);
  fs.writeFileSync(nodeFile, fs.readFileSync(nodeFile, "utf8").replace('title: "Smoke"', 'title: "Smoke, retitled"'));
  const edited = await run(["asset", "import", src, "--title", "Smoke", "--alt", "A test: image", "--json"], { env });
  assert.strictEqual(edited.status, 0, edited.stderr);
  assert.strictEqual(JSON.parse(edited.stdout).status, "replayed");
});

test("local: a forged or missing object fails verification and writes nothing", async () => {
  const home = await localHome();
  const work = scratch("spor-asset-work-");
  const src = path.join(work, "a.png");
  fs.writeFileSync(src, SAMPLE);
  const env = { SPOR_HOME: home };
  const id = JSON.parse((await run(["asset", "import", src, "--json"], { env })).stdout).asset.id;
  const obj = assetLib.objectPath(home, sha(SAMPLE));

  // Forged: other (valid!) image bytes under the descriptor's digest.
  fs.chmodSync(obj, 0o644);
  fs.writeFileSync(obj, png(64, 48, 3));
  const out = scratch("spor-asset-out-");
  for (const args of [["asset", "verify", id], ["asset", "fetch", id, "--out", out]]) {
    const r = await run(args, { env });
    assert.strictEqual(r.status, 1, args.join(" "));
    assert.match(r.stderr, /failed verification: bytes hash to sha256:/);
  }
  assert.deepStrictEqual(fs.readdirSync(out), [], "a failed fetch leaves no file, partial or otherwise");

  // A pin that disagrees with the descriptor never reaches the store.
  const pin = await run(["asset", "verify", id, "--digest", sha(Buffer.from("x"))], { env });
  assert.strictEqual(pin.status, 1);
  assert.match(pin.stderr, /names sha256:/);

  // Missing.
  fs.rmSync(obj);
  const desc = await run(["asset", "describe", id, "--json"], { env });
  assert.strictEqual(JSON.parse(desc.stdout).available, false);
  const miss = await run(["asset", "fetch", id, "--out", out], { env });
  assert.strictEqual(miss.status, 1);
  assert.match(miss.stderr, /not in this graph's asset store/);
  assert.deepStrictEqual(fs.readdirSync(out), []);

  // Re-importing the same image heals the missing object.
  assert.strictEqual((await run(["asset", "import", src], { env })).status, 0);
  assert.strictEqual((await run(["asset", "verify", id], { env })).status, 0);
});

test("local: re-import re-verifies an existing object and replaces a corrupt one", async () => {
  const home = await localHome();
  const work = scratch("spor-asset-work-");
  const src = path.join(work, "a.png");
  fs.writeFileSync(src, SAMPLE);
  const env = { SPOR_HOME: home };
  const id = JSON.parse((await run(["asset", "import", src, "--json"], { env })).stdout).asset.id;
  const obj = assetLib.objectPath(home, sha(SAMPLE));
  for (const corrupt of [() => fs.writeFileSync(obj, png(64, 48, 3)), () => fs.writeFileSync(obj, SAMPLE.subarray(0, 100))]) {
    fs.chmodSync(obj, 0o644);
    corrupt();
    fs.chmodSync(obj, 0o444); // as published: the replace must not need a writable object
    assert.strictEqual((await run(["asset", "verify", id], { env })).status, 1);
    const again = await run(["asset", "import", src], { env });
    assert.strictEqual(again.status, 0, again.stderr);
    assert.ok(fs.readFileSync(obj).equals(SAMPLE), "the corrupt object is replaced by the verified bytes");
    assert.strictEqual(fs.statSync(obj).mode & 0o777, 0o444);
    assert.strictEqual((await run(["asset", "verify", id], { env })).status, 0);
  }
  // A non-file squatting the object path is replaced too.
  fs.rmSync(obj);
  fs.mkdirSync(obj);
  assert.strictEqual((await run(["asset", "import", src], { env })).status, 0);
  assert.ok(fs.readFileSync(obj).equals(SAMPLE));
  // An intact object is kept as is (no rewrite).
  const ino = fs.statSync(obj).ino;
  assert.strictEqual((await run(["asset", "import", src], { env })).status, 0);
  assert.strictEqual(fs.statSync(obj).ino, ino);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, "assets", "staging")), [], "no staging residue");
});

function assetOf(buf, id = "art-x") {
  const info = content.sniffImage(buf);
  return { id, digest: sha(buf), bytes: buf.length, media_type: info.media_type, width: info.width, height: info.height };
}

test("shell: a read is bounded by the descriptor's byte count — the overflow never reaches the sink", async () => {
  const asset = assetOf(SAMPLE);
  let pulled = 0;
  async function* endless() {
    yield SAMPLE;
    for (;;) {
      pulled++;
      yield Buffer.alloc(64 * 1024, 1);
    }
  }
  let sunk = 0;
  await assert.rejects(assetLib.verifyAgainst(endless(), asset, (c) => { sunk += c.length; }), (e) => e.code === "verification_failed" && /more than the descriptor's/.test(e.message));
  assert.strictEqual(sunk, SAMPLE.length, "nothing past the descriptor's bytes is written");
  assert.strictEqual(pulled, 1, "the stream is abandoned at the first over-long chunk");

  // writeVerified leaves no output and no .part behind.
  const out = scratch("spor-asset-out-");
  await assert.rejects(assetLib.writeVerified(endless(), asset, path.join(out, "x.png")), /more than the descriptor's/);
  assert.deepStrictEqual(fs.readdirSync(out), []);
});

test("shell: a fetch without --force never clobbers a file that appears mid-stream", async () => {
  const asset = assetOf(SAMPLE);
  const out = scratch("spor-asset-out-");
  const dest = path.join(out, "x.png");
  async function* racing() {
    yield SAMPLE.subarray(0, 10);
    fs.writeFileSync(dest, "someone else's file");
    yield SAMPLE.subarray(10);
  }
  await assert.rejects(assetLib.writeVerified(racing(), asset, dest), (e) => e.code === "exists");
  assert.strictEqual(fs.readFileSync(dest, "utf8"), "someone else's file");
  assert.deepStrictEqual(fs.readdirSync(out), ["x.png"], "no .part residue");

  // --force replaces it; a fresh path is created with the verified bytes.
  async function* plain() {
    yield SAMPLE;
  }
  assert.strictEqual(await assetLib.writeVerified(plain(), asset, dest, { force: true }), dest);
  assert.ok(fs.readFileSync(dest).equals(SAMPLE));
  const fresh = path.join(out, "y.png");
  assert.strictEqual(await assetLib.writeVerified(plain(), asset, fresh), fresh);
  assert.ok(fs.readFileSync(fresh).equals(SAMPLE));
  assert.strictEqual(fs.statSync(fresh).mode & 0o777, 0o644);
  assert.deepStrictEqual(fs.readdirSync(out).sort(), ["x.png", "y.png"]);
});

test("local: refusals — not an image, wrong digest, conflicting descriptor, not an asset", async () => {
  const home = await localHome();
  const work = scratch("spor-asset-work-");
  const env = { SPOR_HOME: home };
  const txt = path.join(work, "notes.png");
  fs.writeFileSync(txt, "<svg xmlns='http://www.w3.org/2000/svg'/>");
  const bad = await run(["asset", "import", txt], { env });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /not a recognizable PNG, JPEG, GIF or WebP image/);

  const src = path.join(work, "a.png");
  fs.writeFileSync(src, SAMPLE);
  const wrong = await run(["asset", "import", src, "--digest", sha(Buffer.from("x"))], { env });
  assert.strictEqual(wrong.status, 1);
  assert.match(wrong.stderr, /expected sha256:/);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, "nodes")).filter((f) => f.startsWith("art-")), [], "nothing written");
  assert.deepStrictEqual(fs.readdirSync(path.join(home, "assets", "staging")), [], "staging cleaned up");

  assert.strictEqual((await run(["asset", "import", src, "--id", "art-shot", "--alt", "one"], { env })).status, 0);
  const clash = await run(["asset", "import", src, "--id", "art-shot", "--alt", "two"], { env });
  assert.strictEqual(clash.status, 1);
  assert.match(clash.stderr, /already names different metadata/);

  fs.writeFileSync(path.join(home, "nodes", "art-plain.md"), "---\nid: art-plain\ntype: artifact\ntitle: Plain\nsummary: A plain artifact.\ndate: 2026-10-09\n---\n\nbody\n");
  const notAsset = await run(["asset", "describe", "art-plain"], { env });
  assert.strictEqual(notAsset.status, 1);
  assert.match(notAsset.stderr, /not an asset descriptor/);
  const clash2 = await run(["asset", "import", src, "--id", "art-plain"], { env });
  assert.strictEqual(clash2.status, 1);
  assert.match(clash2.stderr, /not this asset/);
});

test("cli: help, usage and misplaced options", async () => {
  const h = await run(["help", "asset"]);
  assert.strictEqual(h.status, 0, h.stderr);
  for (const s of ["import", "describe", "fetch", "verify", "--idempotency-key"]) assert.ok(h.stdout.includes(s), s);
  const top = await run(["help"]);
  assert.match(top.stdout, /\basset\b/);
  const home = await localHome();
  const u = await run(["asset", "frobnicate", "x"], { env: { SPOR_HOME: home } });
  assert.strictEqual(u.status, 1);
  assert.match(u.stderr, /usage: spor asset/);
  const mis = await run(["asset", "describe", "art-x", "--title", "t"], { env: { SPOR_HOME: home } });
  assert.strictEqual(mis.status, 1);
  assert.match(mis.stderr, /does not take --title/);
  const badRef = await run(["asset", "fetch", "../../etc/passwd"], { env: { SPOR_HOME: home } });
  assert.strictEqual(badRef.status, 1);
  assert.match(badRef.stderr, /not a node id/);
});

// --- remote mode ----------------------------------------------------------------

// A stub of the server's asset routes (rest-fastify.ts assetUploadRoute /
// assetDescribeRoute / assetContentRoute). `forge` serves other bytes than the
// descriptor names; `resetFirst` drops the first upload's connection (the
// refusal-as-socket-reset the upload door documents).
function startAssetStub({ forge = false, oversize = false, resetFirst = false, keyOwners = null } = {}) {
  const sent = { bytes: 0 };
  const nodes = new Map(); // id -> {raw, fm}
  const bytes = new Map(); // digest -> Buffer
  const journal = new Map(); // key -> id
  const uploads = [];
  let resets = resetFirst ? 1 : 0;
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://stub");
    if (req.headers.authorization !== "Bearer tok") return send(res, 401, { error: { code: "unauthorized", message: "no" } });
    if (req.method === "POST" && url.pathname === "/v1/assets") {
      if (resets > 0) {
        resets--;
        uploads.push({ reset: true, key: req.headers["idempotency-key"] });
        req.socket.destroy();
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const sp = url.searchParams;
      const key = req.headers["idempotency-key"];
      if (keyOwners && keyOwners.has(key) && keyOwners.get(key) !== req.headers.authorization) {
        uploads.push({ key, refused: true });
        return send(res, 409, { error: { code: "idempotency_key_reused", message: "this idempotency key belongs to another principal's upload" } });
      }
      if (keyOwners && !keyOwners.has(key)) keyOwners.set(key, req.headers.authorization);
      uploads.push({ key, query: Object.fromEntries(sp), contentType: req.headers["content-type"], length: body.length });
      const info = content.sniffImage(body);
      const digest = sha(body);
      if (sp.get("digest") && sp.get("digest") !== digest) return send(res, 422, { error: { code: "digest_mismatch", message: "no" } });
      const meta = content.normalizeAssetMeta({ key, id: sp.get("id"), title: sp.get("title"), summary: sp.get("summary"), alt: sp.get("alt"), project: sp.get("project") }, "local");
      const replay = journal.get(key);
      if (!replay) {
        if (nodes.has(meta.id)) return send(res, 409, { error: { code: "descriptor_conflict", message: `descriptor id '${meta.id}' belongs to another upload` } });
        const raw = content.assetDescriptorText(meta, { digest, size: body.length, ...info });
        nodes.set(meta.id, { raw, fm: require("../lib/graph.js").parseFrontmatter(raw, `${meta.id}.md`) });
        bytes.set(digest, body);
        journal.set(key, meta.id);
      }
      const a = { id: meta.id, uri: content.formatAssetUri({ id: meta.id, digest }), digest, media_type: info.media_type, bytes: body.length, width: info.width, height: info.height };
      return send(res, replay ? 200 : 201, { status: replay ? "replayed" : "created", idempotency_key: key, descriptor: { id: meta.id, revision: "f".repeat(40) }, asset: a, preview: { width: 64, height: 48, path: "/v1/assets/preview/x" }, warnings: [] });
    }
    const m = /^\/v1\/assets\/([a-z0-9-]+)(\/content)?$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const n = nodes.get(m[1]);
      if (!n) return send(res, 404, { error: { code: "not_found", message: `no node '${m[1]}'` } });
      const d = content.assetDescriptor(n.fm);
      const pin = url.searchParams.get("digest");
      if (pin && pin !== d.digest) return send(res, 409, { error: { code: "digest_mismatch", message: "pin" } });
      if (!m[2]) {
        return send(res, 200, {
          asset: { id: m[1], uri: content.formatAssetUri({ id: m[1], digest: d.digest }), digest: d.digest, media_type: d.media_type, bytes: d.bytes, width: d.width, height: d.height, alt: d.alt, title: n.fm.title, summary: n.fm.summary, revision: "f".repeat(40) },
          available: bytes.has(d.digest),
          variants: {},
          links: { preview: { path: "/v1/assets/preview/x" } },
        });
      }
      if (oversize) {
        // The descriptor's bytes, then junk without end (chunked, no length),
        // until the client hangs up — or a 256MB backstop.
        res.writeHead(200, { "content-type": d.media_type });
        let first = true;
        const junk = Buffer.alloc(64 * 1024, 1);
        const pump = () => {
          while (!res.destroyed && sent.bytes < 256 * 1024 * 1024) {
            const c = first ? bytes.get(d.digest) : junk;
            first = false;
            sent.bytes += c.length;
            if (!res.write(c)) return res.once("drain", pump);
          }
          res.end();
        };
        res.on("close", () => { sent.closed = true; });
        return pump();
      }
      const b = forge ? png(64, 48, 3) : bytes.get(d.digest);
      res.writeHead(200, { "content-type": d.media_type, "content-length": String(b.length) });
      return res.end(b);
    }
    send(res, 404, { error: { code: "not_found", message: "no route" } });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${srv.address().port}`, uploads, sent, close: () => new Promise((r) => srv.close(r)) }));
  });
}

test("remote: the same image imports and fetches with the same descriptor fields as local", async () => {
  const stub = await startAssetStub();
  try {
    const work = scratch("spor-asset-work-");
    const src = path.join(work, "private-dir-name.png");
    fs.writeFileSync(src, SAMPLE);
    const renv = { SPOR_HOME: scratch("spor-asset-rhome-"), SPOR_SERVER: stub.base, SPOR_TOKEN: "tok" };
    const args = ["asset", "import", src, "--title", "Smoke", "--alt", "A test: image", "--json"];
    const imp = await run(args, { env: renv });
    assert.strictEqual(imp.status, 0, imp.stderr);
    const r = JSON.parse(imp.stdout);

    // The request shape: raw bytes as the body, metadata in the query string.
    const up = stub.uploads[0];
    assert.deepStrictEqual(up.query, { title: "Smoke", alt: "A test: image", digest: sha(SAMPLE) });
    assert.strictEqual(up.contentType, "image/png");
    assert.strictEqual(up.length, SAMPLE.length);
    assert.match(up.key, /^spor-cli\.[0-9a-f]{40}$/);
    assert.doesNotMatch(JSON.stringify(up), /private-dir-name/, "no path or filename leaves the box");

    // Parity with a local import of the same image + metadata.
    const lenv = { SPOR_HOME: await localHome() };
    const loc = JSON.parse((await run(args, { env: lenv })).stdout);
    assert.deepStrictEqual(r.asset, loc.asset);
    assert.strictEqual(r.embed, loc.embed, "both modes return the captioned digest-pinned embed");
    assert.strictEqual(r.idempotency_key, loc.idempotency_key);
    const rd = JSON.parse((await run(["asset", "describe", r.asset.id, "--json"], { env: renv })).stdout);
    const ld = JSON.parse((await run(["asset", "describe", loc.asset.id, "--json"], { env: lenv })).stdout);
    const fields = (x) => ({ ...x.asset, revision: undefined });
    assert.deepStrictEqual(fields(rd), fields(ld));
    assert.strictEqual(rd.available, ld.available);
    assert.strictEqual(rd.links, undefined, "ticket capabilities are not printed");

    // Re-import replays under the same key.
    const again = JSON.parse((await run(args, { env: renv })).stdout);
    assert.strictEqual(again.status, "replayed");
    assert.strictEqual(stub.uploads[1].key, up.key);

    const out = scratch("spor-asset-out-");
    const f = await run(["asset", "fetch", r.asset.uri, "--out", path.join(out, "x.png")], { env: renv });
    assert.strictEqual(f.status, 0, f.stderr);
    assert.ok(fs.readFileSync(path.join(out, "x.png")).equals(SAMPLE));
    assert.strictEqual((await run(["asset", "verify", r.asset.id], { env: renv })).status, 0);
  } finally {
    await stub.close();
  }
});

test("remote: forged bytes from the server fail verification and write nothing", async () => {
  const stub = await startAssetStub({ forge: true });
  try {
    const work = scratch("spor-asset-work-");
    const src = path.join(work, "a.png");
    fs.writeFileSync(src, SAMPLE);
    const env = { SPOR_HOME: scratch("spor-asset-rhome-"), SPOR_SERVER: stub.base, SPOR_TOKEN: "tok" };
    const id = JSON.parse((await run(["asset", "import", src, "--json"], { env })).stdout).asset.id;
    const out = scratch("spor-asset-out-");
    const f = await run(["asset", "fetch", id, "--out", out], { env });
    assert.strictEqual(f.status, 1);
    assert.match(f.stderr, /failed verification/);
    assert.deepStrictEqual(fs.readdirSync(out), []);
    assert.strictEqual((await run(["asset", "verify", id], { env })).status, 1);
  } finally {
    await stub.close();
  }
});

test("remote: a response running past the descriptor's bytes is cut off and writes nothing", async () => {
  const stub = await startAssetStub({ oversize: true });
  try {
    const work = scratch("spor-asset-work-");
    const src = path.join(work, "a.png");
    fs.writeFileSync(src, SAMPLE);
    const env = { SPOR_HOME: scratch("spor-asset-rhome-"), SPOR_SERVER: stub.base, SPOR_TOKEN: "tok" };
    const id = JSON.parse((await run(["asset", "import", src, "--json"], { env })).stdout).asset.id;
    const out = scratch("spor-asset-out-");
    for (const args of [["asset", "fetch", id, "--out", out], ["asset", "verify", id]]) {
      stub.sent.bytes = 0;
      const f = await run(args, { env });
      assert.strictEqual(f.status, 1, args.join(" "));
      assert.match(f.stderr, /more than the descriptor's/);
      assert.ok(stub.sent.bytes < 64 * 1024 * 1024, `the client hung up early (server sent ${stub.sent.bytes})`);
    }
    assert.deepStrictEqual(fs.readdirSync(out), []);
  } finally {
    await stub.close();
  }
});

test("remote: exchange() reports an unparseable error body as jsonError, like request()", async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(502, { "content-type": "text/html" });
    res.end("<html>bad gateway</html>");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const remote = require("../lib/remote.js");
    const cfg = { server: () => `http://127.0.0.1:${srv.address().port}`, token: () => "tok", get: () => undefined };
    const r = await remote.exchange(cfg, "GET", "/v1/assets/x/content", { token: "tok", timeoutMs: 5000 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.json, null);
    assert.ok(r.jsonError, "a body that failed to parse is distinguishable from an empty one");
    assert.strictEqual(r.text, "<html>bad gateway</html>");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("remote: a reset upload is retried once under the same idempotency key; refusals are reported", async () => {
  const stub = await startAssetStub({ resetFirst: true });
  try {
    const work = scratch("spor-asset-work-");
    const src = path.join(work, "a.png");
    fs.writeFileSync(src, SAMPLE);
    const env = { SPOR_HOME: scratch("spor-asset-rhome-"), SPOR_SERVER: stub.base, SPOR_TOKEN: "tok" };
    const imp = await run(["asset", "import", src, "--id", "art-shot", "--json"], { env });
    assert.strictEqual(imp.status, 0, imp.stderr);
    assert.strictEqual(stub.uploads.length, 2);
    assert.strictEqual(stub.uploads[0].reset, true);
    assert.strictEqual(stub.uploads[1].key, stub.uploads[0].key);
    assert.strictEqual(stub.uploads[1].query.id, "art-shot");

    fs.writeFileSync(path.join(work, "b.png"), png(64, 48, 5));
    const clash = await run(["asset", "import", path.join(work, "b.png"), "--id", "art-shot"], { env });
    assert.strictEqual(clash.status, 1);
    assert.match(clash.stderr, /409 descriptor_conflict/);
    // A local verification refusal never reaches the server.
    const before = stub.uploads.length;
    fs.writeFileSync(path.join(work, "c.png"), SAMPLE.subarray(0, SAMPLE.length - 4));
    const cut = await run(["asset", "import", path.join(work, "c.png")], { env });
    assert.strictEqual(cut.status, 1);
    assert.match(cut.stderr, /truncated or corrupt/);
    assert.strictEqual(stub.uploads.length, before);
  } finally {
    await stub.close();
  }
});

test("remote: a derived key another principal owns falls back to a per-caller key that still replays", async () => {
  const keyOwners = new Map();
  const stub = await startAssetStub({ keyOwners });
  try {
    const work = scratch("spor-asset-work-");
    const src = path.join(work, "a.png");
    fs.writeFileSync(src, SAMPLE);
    const env = { SPOR_HOME: scratch("spor-asset-rhome-"), SPOR_SERVER: stub.base, SPOR_TOKEN: "tok" };
    // Someone else already imported the same image under the shared derived key.
    const shared = assetLib.importKey(sha(SAMPLE), { id: null, title: null, summary: null, alt: null, project: null });
    keyOwners.set(shared, "Bearer someone-else");
    const first = await run(["asset", "import", src, "--json"], { env });
    assert.strictEqual(first.status, 0, first.stderr);
    const r = JSON.parse(first.stdout);
    assert.strictEqual(r.status, "created");
    assert.match(r.idempotency_key, new RegExp(`^${shared.replace(".", "\\.")}\\.[0-9a-f]{12}$`));
    const again = await run(["asset", "import", src, "--json"], { env });
    assert.strictEqual(JSON.parse(again.stdout).status, "replayed");
    assert.strictEqual(JSON.parse(again.stdout).asset.id, r.asset.id);
    // An explicit key is the user's: never silently replaced.
    keyOwners.set("my-key-0001", "Bearer someone-else");
    const mine = await run(["asset", "import", src, "--idempotency-key", "my-key-0001"], { env });
    assert.strictEqual(mine.status, 1);
    assert.match(mine.stderr, /idempotency_key_reused/);
  } finally {
    await stub.close();
  }
});

// issue-spor-cli-offline-wording-residuals: a reset upload followed by a
// refused re-send is not "offline" — the reset attempt may have landed it.
test("asset import (remote): a reset then a refused re-send says the upload may have landed, never 'offline'", async () => {
  const remote = require("../lib/remote.js");
  const work = scratch("spor-asset-work-");
  const src = path.join(work, "a.png");
  fs.writeFileSync(src, SAMPLE);
  // The first upload is reset mid-request; the server is gone by the re-send.
  const srv = http.createServer((req) => {
    req.socket.destroy();
    srv.close();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cfg = { server: () => base, token: () => "tok", get: () => undefined };
  await assert.rejects(assetLib.importRemote({ cfg, remote, file: src, opts: { id: "art-shot" } }), (e) => {
    assert.doesNotMatch(e.message, /offline/);
    assert.match(e.message, /^connection to server failed \(.*after an earlier attempt failed with .*\) — the write may have landed; re-running the import is safe/);
    return true;
  });
  // a refused connect on BOTH attempts never reached the server: offline
  await assert.rejects(assetLib.importRemote({ cfg, remote, file: src, opts: { id: "art-shot" } }), /offline — could not reach server/);
});

// issue-spor-busy-retryable-flag-and-retry-layers: the transport re-send and
// the busy re-sends share ONE budget, so an import is bounded to 1 +
// BUSY_MAX_RETRIES attempts, never the two layers stacked (8).
test("asset import (remote): busy and transport re-sends share one bounded budget", async () => {
  const busyLib = require("../lib/shell/busy.js");
  const work = scratch("spor-asset-work-");
  const src = path.join(work, "a.png");
  fs.writeFileSync(src, SAMPLE);
  const BUSY = { ok: false, status: 503, json: { error: { code: "busy", retryable: true, retry_after: 0 } }, headers: {} };
  const RESET = { ok: false, transport: true, error: "fetch failed: other side closed" };
  const calls = [];
  // the stub runs the real budget (busy.withBusyRetry) over a scripted wire
  const scripted = (script) => ({
    exchange: async (_cfg, _m, _p, o) => {
      let n = 0;
      return busyLib.withBusyRetry(async () => {
        o.body();
        calls.push(o.headers["idempotency-key"]);
        return script[Math.min(calls.length - 1, script.length - 1)] || script[script.length - 1];
      }, { retries: o.retries, transportRetries: o.transportRetries, replaySafe: true, sleep: async () => n++ });
    },
  });
  await assert.rejects(assetLib.importRemote({ cfg: {}, remote: scripted([RESET, BUSY, RESET, RESET, RESET, BUSY]), file: src, opts: { id: "art-shot" } }));
  assert.strictEqual(calls.length, 1 + busyLib.BUSY_MAX_RETRIES - 1, "one transport re-send only: reset, busy, reset, then stop");
  calls.length = 0;
  await assert.rejects(assetLib.importRemote({ cfg: {}, remote: scripted([BUSY]), file: src, opts: { id: "art-shot" } }));
  assert.strictEqual(calls.length, 1 + busyLib.BUSY_MAX_RETRIES);
});
// issue-spor-hook-curl-retries-nonretryable-busy: the salted-key send spends
// what the first send left, counted from exchange()'s own `attempts` — a 401
// refresh's re-send (which runs the body factory again) is not budget.
test("asset import (remote): a token refresh on the first send does not shrink the salted send's budget", async () => {
  const busyLib = require("../lib/shell/busy.js");
  const work = scratch("spor-asset-work-");
  const src = path.join(work, "a.png");
  fs.writeFileSync(src, SAMPLE);
  const REUSED = { ok: false, status: 409, json: { error: { code: "idempotency_key_reused" } }, headers: {} };
  const BUSY = { ok: false, status: 503, json: { error: { code: "busy", retryable: true, retry_after: 0 } }, headers: {} };
  const keys = [];
  const remote = {
    token: () => "tok",
    base: () => "http://x",
    exchange: async (_cfg, _m, _p, o) => {
      if (!keys.length) {
        // the first send: a 401, a refresh, its re-send — two body reads, one attempt
        o.body();
        o.body();
        keys.push(o.headers["idempotency-key"]);
        return { ...REUSED, attempts: 1 };
      }
      let attempts = 0;
      const r = await busyLib.withBusyRetry(async () => {
        attempts++;
        o.body();
        keys.push(o.headers["idempotency-key"]);
        return BUSY;
      }, { retries: o.retries, replaySafe: true, sleep: async () => {} });
      return { ...r, attempts };
    },
  };
  await assert.rejects(assetLib.importRemote({ cfg: {}, remote, file: src, opts: { id: "art-shot" } }));
  assert.strictEqual(keys.length - 1, 1 + busyLib.BUSY_MAX_RETRIES, "the salted key keeps the whole remaining budget");
  assert.notStrictEqual(keys[1], keys[0]);
});
