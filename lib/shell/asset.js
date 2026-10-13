"use strict";
// shell/asset.js — the IO half of `spor asset import|describe|fetch|verify`
// (task-spor-chatgpt-asset-cli, Phase 3 of the ChatGPT workspace program). The
// pure half — what an image's bytes declare, the canonical descriptor text, the
// safe fetch filename — is lib/kernel/content.js; this module streams bytes,
// keeps the LOCAL content-addressed store, and talks to the server's byte
// routes. Plain Node: fs streams + crypto, no image or markdown library.
//
// One contract, two backings (norm-spor-cli-mode-parity):
//
//   remote  POST /v1/assets streams the file as the request body with the
//           metadata in the query string (dec-spor-chatgpt-asset-upload-query-
//           metadata-2026-10-09) under an Idempotency-Key; GET /v1/assets/:id
//           describes, GET /v1/assets/:id/content serves the verified bytes.
//   local   $SPOR_HOME/assets/ in the server's own LocalAssetStore layout
//           (staging/<uuid>, sha256/<hex[0..2]>/<hex>, published 0444, kept
//           out of graph Git via .git/info/exclude), and the descriptor written
//           through the validated local put_node door.
//
// Either way the bytes are VERIFIED, never trusted: an import measures them
// before anything is published (size cap, header-only media + pixel checks,
// the end-of-stream structure check, an optional declared digest), and every
// read re-hashes what it streams and compares it with the DESCRIPTOR — digest,
// byte count, media type and pixel dimensions — before an output file exists.
// That is the local twin of the server's descriptor guard: a forged object (a
// store file whose bytes are not its name) or a missing one fails. No local
// path, file name or host detail is ever written to the graph.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const content = require("../kernel/content.js");
const { linkOrReserve, replaceFileSync } = require("./spool.js");
const { BUSY_MAX_RETRIES } = require("./busy.js");

class AssetError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const DIGEST_RE = /^sha256:([0-9a-f]{64})$/;

// ---------------------------------------------------------------------------
// Streaming measurement.

// measure(source, opts) -> {digest, size, media_type, width, height}. Reads an
// async iterable of chunks once: hashes, counts, probes the header, keeps the
// tail, and (when given) hands every chunk to `sink`. `image: true` applies the
// upload rules (unsupported media, pixel cap, truncation); `maxBytes` bounds the
// stream; `expectedDigest` refuses different bytes.
async function measure(source, { maxBytes = content.ASSET_MAX_BYTES, maxPixels = content.ASSET_MAX_PIXELS, image = true, expectedDigest = null, sink = null } = {}) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let info;
  for await (const raw of source) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > maxBytes) throw new AssetError("too_large", `asset exceeds ${maxBytes} bytes`);
    hash.update(chunk);
    if (info === undefined && head.length < content.ASSET_PROBE_BYTES) {
      head = Buffer.concat([head, chunk.subarray(0, content.ASSET_PROBE_BYTES - head.length)]);
      info = probe(head, head.length >= content.ASSET_PROBE_BYTES, maxPixels, image);
    }
    tail = chunk.length >= content.ASSET_TAIL_BYTES
      ? Buffer.from(chunk.subarray(chunk.length - content.ASSET_TAIL_BYTES))
      : Buffer.concat([tail, chunk]).subarray(-content.ASSET_TAIL_BYTES);
    if (sink) await sink(chunk);
  }
  if (info === undefined) info = probe(head, true, maxPixels, image);
  if (info && image) {
    const e = content.assetTrailerError(info, head, tail, size);
    if (e) throw new AssetError("malformed_image", e);
  }
  const digest = `sha256:${hash.digest("hex")}`;
  if (expectedDigest && digest !== expectedDigest) {
    throw new AssetError("digest_mismatch", `asset bytes hash to ${digest}, expected ${expectedDigest}`);
  }
  return { digest, size, media_type: info ? info.media_type : null, width: info ? info.width : null, height: info ? info.height : null };
}

// undefined = need more bytes; null = not an image (only when !image); else info.
function probe(head, final, maxPixels, image) {
  const info = content.sniffImage(head);
  if (!info) {
    if (!final) return undefined;
    if (image) throw new AssetError("unsupported_media", "not a recognizable PNG, JPEG, GIF or WebP image");
    return null;
  }
  if (image && info.width * info.height > maxPixels) {
    throw new AssetError("too_many_pixels", `${info.width}x${info.height} exceeds ${maxPixels} pixels`);
  }
  return info;
}

// The bytes of a read must be exactly what the descriptor names: digest, size,
// and the media type + dimensions the header declares. A read with no image
// limits (bytes accepted once must come back even if a cap tightened since) —
// but bounded by the DESCRIPTOR's own byte count: a stream running past it is
// already wrong, so it is refused at that chunk, before the chunk reaches the
// sink, and a hostile or broken response can never fill the disk.
async function verifyAgainst(source, asset, sink = null) {
  const limit = Number.isSafeInteger(asset.bytes) && asset.bytes >= 0 ? asset.bytes : 0;
  let m;
  try {
    m = await measure(source, { maxBytes: limit, maxPixels: Number.POSITIVE_INFINITY, image: false, sink });
  } catch (e) {
    if (e instanceof AssetError && e.code === "too_large") {
      throw new AssetError("verification_failed", `'${asset.id}' failed verification: more than the descriptor's ${asset.bytes} bytes`);
    }
    throw e;
  }
  const bad = [];
  if (m.digest !== asset.digest) bad.push(`bytes hash to ${m.digest}, descriptor names ${asset.digest}`);
  if (m.size !== asset.bytes) bad.push(`${m.size} bytes, descriptor says ${asset.bytes}`);
  if (m.media_type !== asset.media_type) bad.push(`bytes are ${m.media_type || "not a recognizable image"}, descriptor says ${asset.media_type}`);
  else if (m.width !== asset.width || m.height !== asset.height) bad.push(`bytes declare ${m.width}x${m.height}, descriptor says ${asset.width}x${asset.height}`);
  if (bad.length) throw new AssetError("verification_failed", `'${asset.id}' failed verification: ${bad.join("; ")}`);
  return m;
}

// fs.writeSync may write fewer bytes than asked (a full disk): loop until the
// whole chunk is down, and let a real error throw.
function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

// The file behind `fd` must hold exactly what was measured before it is made
// readable under a name.
function assertWritten(fd, size) {
  const got = fs.fstatSync(fd).size;
  if (got !== size) throw new AssetError("write_failed", `wrote ${got} of ${size} bytes`);
}

function readSource(file) {
  return fs.createReadStream(file, { highWaterMark: 64 * 1024 });
}

// A regular, readable file, or an AssetError naming only the argument the user
// gave (never resolved through symlinks into a message).
function checkInputFile(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    throw new AssetError("not_found", `cannot read '${file}': ${e.code || e.message}`);
  }
  if (!st.isFile()) throw new AssetError("bad_request", `'${file}' is not a regular file`);
  if (st.size === 0) throw new AssetError("bad_request", `'${file}' is empty`);
  if (st.size > content.ASSET_MAX_BYTES) throw new AssetError("too_large", `asset exceeds ${content.ASSET_MAX_BYTES} bytes`);
  return st;
}

// ---------------------------------------------------------------------------
// The local content-addressed store (the server's LocalAssetStore layout).

function assetsRoot(home) {
  return path.join(home, "assets");
}
function objectPath(home, digest) {
  const m = DIGEST_RE.exec(String(digest));
  if (!m) throw new AssetError("invalid_digest", `invalid asset digest ${JSON.stringify(digest)}`);
  return path.join(assetsRoot(home), "sha256", m[1].slice(0, 2), m[1]);
}

// Keep assets/ out of graph Git without touching a tracked file: a `git add
// -A` in the graph home (spor migrate) still cannot sweep the bytes in. Best
// effort. The .git/info/exclude line is the server's own move; the
// self-ignoring assets/.gitignore also covers a graph home NESTED in a code
// repo (a `graph:` marker home), which has no .git of its own.
function excludeFromGit(home) {
  try {
    const own = path.join(assetsRoot(home), ".gitignore");
    if (!fs.existsSync(own)) {
      fs.mkdirSync(assetsRoot(home), { recursive: true });
      fs.writeFileSync(own, "# spor asset bytes live outside graph Git (GRAPH.md \"Rich content and assets\")\n*\n");
    }
  } catch {
    /* best effort */
  }
  const exclude = path.join(home, ".git", "info", "exclude");
  try {
    if (!fs.statSync(path.join(home, ".git")).isDirectory()) return;
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (cur.split(/\r?\n/).some((l) => l.trim() === "/assets/" || l.trim() === "assets/")) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${cur && !cur.endsWith("\n") ? "\n" : ""}/assets/\n`);
  } catch {
    /* best effort */
  }
}

function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    /* a filesystem that cannot fsync a directory */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Does the file at `p` hash to `digest`? false on any read failure — an object
// we cannot read back is no more trustworthy than one that reads wrong.
function objectIntact(p, digest) {
  let fd;
  try {
    if (!fs.lstatSync(p).isFile()) return false;
    fd = fs.openSync(p, "r");
    const hash = crypto.createHash("sha256");
    const buf = Buffer.alloc(64 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
    return `sha256:${hash.digest("hex")}` === digest;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Stream `file` into staging while measuring it; returns {asset, publish(),
// abort()}. Nothing is readable under a digest until publish().
async function stageLocal(home, file, opts) {
  const dir = path.join(assetsRoot(home), "staging");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, crypto.randomUUID());
  const fd = fs.openSync(tmp, "wx", 0o600);
  let open = true;
  const close = () => {
    if (open) {
      open = false;
      fs.closeSync(fd);
    }
  };
  let asset;
  try {
    asset = await measure(readSource(file), { ...opts, sink: (c) => writeAll(fd, c) });
    fs.fsyncSync(fd);
    assertWritten(fd, asset.size);
    close();
  } catch (e) {
    close();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  let done = false;
  return {
    asset,
    // -> true when these bytes were newly published, false when the store
    // already held the digest. An existing object is RE-HASHED, never trusted
    // on its name: content addressing only promises same digest, same bytes
    // for an object that was verified, and a corrupt or forged one (or a
    // non-file squatting its path) is replaced with the bytes just measured.
    publish() {
      if (done) throw new Error("staged write already finished");
      done = true;
      const dest = objectPath(home, asset.digest);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (fs.existsSync(dest) && objectIntact(dest, asset.digest)) {
          fs.rmSync(tmp, { force: true });
          return false;
        }
        try {
          // A non-file squatter (a directory) cannot be renamed over, and on
          // Windows neither can a read-only (0444, as published) file.
          if (!fs.lstatSync(dest).isFile()) fs.rmSync(dest, { recursive: true, force: true });
          else fs.chmodSync(dest, 0o644);
        } catch {
          /* absent */
        }
        fs.chmodSync(tmp, 0o444);
        replaceFileSync(tmp, dest); // a concurrent fetch/export may hold the object open
        fsyncDir(path.dirname(dest));
        return true;
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
    },
    abort() {
      if (done) return;
      done = true;
      fs.rmSync(tmp, { force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// References and descriptors.

// parseRef(text, digest) -> {id, pin}: a descriptor id or a spor-asset: URI,
// with an optional --digest pin that must agree with the URI's own.
function parseRef(text, digest = null) {
  let id = String(text || "");
  let pin = digest ? String(digest) : null;
  if (id.startsWith(content.ASSET_SCHEME)) {
    const p = content.parseAssetUri(id);
    if (!p.ok) throw new AssetError("invalid_asset_uri", p.error);
    if (pin && p.digest && pin !== p.digest) throw new AssetError("invalid_request", "--digest and the uri's pin disagree");
    id = p.id;
    pin = pin || p.digest;
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || id.length > 200) {
    throw new AssetError("invalid_request", `'${id}' is not a node id or ${content.ASSET_SCHEME} URI`);
  }
  if (pin && !DIGEST_RE.test(pin)) throw new AssetError("invalid_digest", "digest must be sha256:<64 lowercase hex>");
  return { id, pin };
}

// The descriptor view both modes print (the server's describe `asset` shape).
function assetView(id, fm, revision) {
  const d = content.assetDescriptor(fm);
  if (!d) return null;
  return {
    id,
    uri: content.formatAssetUri({ id, digest: d.digest }),
    digest: d.digest,
    media_type: d.media_type,
    bytes: d.bytes,
    width: d.width,
    height: d.height,
    alt: d.alt,
    title: typeof fm.title === "string" ? fm.title : null,
    summary: typeof fm.summary === "string" ? fm.summary : null,
    revision: revision || null,
  };
}

// Server error envelope -> AssetError.
function serverError(r, what) {
  // The upload is a write: a failure on a made connection may have landed it.
  if (r.transport) return new AssetError("offline", require("../remote.js").describeTransport(r, what === "upload" ? { write: "re-running the import is safe (it replays under the same idempotency key)" } : {}));
  const e = r.json && r.json.error;
  const code = (e && e.code) || `http_${r.status}`;
  const details = e && Array.isArray(e.details) && e.details.length ? ` (${e.details.join("; ")})` : "";
  return new AssetError(code, `${what} refused: ${r.status} ${code}${e && e.message ? ` — ${e.message}` : ""}${details}`);
}

// ---------------------------------------------------------------------------
// Import.

// The idempotency key a CLI import sends when the user names none: derived
// from the bytes and the metadata, so re-importing the same image with the same
// metadata names the same upload — and so the same descriptor — in either mode,
// and a retry after a dropped connection reconciles instead of duplicating.
function importKey(digest, meta) {
  const h = crypto.createHash("sha256")
    .update(JSON.stringify([digest, meta.id || null, meta.title, meta.summary, meta.alt, meta.project]))
    .digest("hex");
  return `spor-cli.${h.slice(0, 40)}`;
}

// A short, stable digest of WHO is calling which server: the JWT subject (an
// access token refreshes; its subject does not) or, for an opaque token, the
// token itself. Never sent in the clear.
function principalSalt(cfg, remote) {
  const token = remote.token(cfg);
  const p = require("../auth.js").decodeJwt(token);
  const who = p && (p.sub || p.email) ? `jwt:${p.sub || p.email}:${p.agent || ""}` : `token:${token}`;
  return crypto.createHash("sha256").update(`${remote.base(cfg)}\n${who}`).digest("hex").slice(0, 12);
}

function importMeta(opts, digest, tenant) {
  // Normalize the caption fields first (the key covers their canonical form).
  const pre = content.normalizeAssetMeta({ ...opts, key: "placeholder", digest: opts.digest || null }, tenant);
  const given = opts.id ? pre.id : null;
  const key = opts.key || importKey(digest, { ...pre, id: given });
  return content.normalizeAssetMeta({ ...opts, key, digest: opts.digest || null }, tenant);
}

function metaError(e) {
  return e instanceof AssetError ? e : new AssetError("invalid_request", e.message);
}

// importLocal({home, nodesDir, file, opts, putNode}) -> result envelope (the
// server's upload response shape). putNode(raw, id) is the validated local
// put_node door (bin/spor.js putNodeLocal) for node `id`; it returns {ok,
// res|error}.
async function importLocal({ home, nodesDir, file, opts, putNode }) {
  checkInputFile(file);
  try {
    content.normalizeAssetMeta({ ...opts, key: "placeholder" });
  } catch (e) {
    throw metaError(e);
  }
  excludeFromGit(home);
  const staged = await stageLocal(home, file, { expectedDigest: opts.digest || null });
  const a = staged.asset;
  let meta;
  try {
    meta = importMeta(opts, a.digest, "local");
  } catch (e) {
    staged.abort();
    throw metaError(e);
  }
  const raw = content.assetDescriptorText(meta, a);
  const nodeFile = path.join(nodesDir, `${meta.id}.md`);
  if (fs.existsSync(nodeFile)) {
    // One descriptor per upload. An existing node is THIS upload's when the
    // upload journal says this key completed it and it still names these
    // bytes (a replay — captions edited since do not matter, as on the
    // server); or, with no journal entry, when it names these bytes and this
    // metadata (a crash between the node write and the journal: reconciled).
    // Anything else is a conflict.
    const graphLib = require("../graph.js");
    let cur;
    try {
      cur = fs.readFileSync(nodeFile);
    } catch (e) {
      staged.abort();
      throw new AssetError("descriptor_conflict", `cannot read existing node '${meta.id}': ${e.code || e.message}`);
    }
    let fm = null;
    try {
      fm = graphLib.parseFrontmatter(cur.toString("utf8"), `${meta.id}.md`);
    } catch {
      fm = null;
    }
    const d = fm ? content.assetDescriptor(fm) : null;
    const j = readUpload(home, meta.key);
    let status = null;
    if (d && d.digest === a.digest && j && j.id === meta.id && j.digest === a.digest) status = "replayed";
    else if (d && d.digest === a.digest) {
      const want = graphLib.parseFrontmatter(raw, `${meta.id}.md`);
      if (["title", "summary", "project", "asset_alt"].every((k) => String(fm[k] ?? "") === String(want[k] ?? ""))) status = "reconciled";
    }
    if (!status) {
      staged.abort();
      throw new AssetError("descriptor_conflict", `descriptor id '${meta.id}' already names ${d ? `different ${d.digest === a.digest ? "metadata" : "bytes"}` : "a node that is not this asset"}`);
    }
    // Heal a descriptor whose bytes went missing; otherwise drop the staging copy.
    staged.publish();
    if (status === "reconciled") writeUpload(home, meta.key, meta.id, a.digest);
    return resultOf(meta, a, gitBlobSha(cur), status, []);
  }
  staged.publish();
  // The server's write door defaults `date` on a create (write-pipeline 3d);
  // the local door does not, so stamp it here the same way (appended last).
  const dated = require("../kernel/frontmatter.js").withKey(raw, "date", new Date().toISOString().slice(0, 10));
  const w = putNode(dated == null ? raw : dated, meta.id);
  if (!w.ok) throw new AssetError("invalid_node", w.error);
  writeUpload(home, meta.key, meta.id, a.digest);
  return resultOf(meta, a, w.res.revision, "created", w.res.warnings || []);
}

// The local upload journal: one small file per idempotency key that completed
// a descriptor, under assets/uploads/ (outside graph Git with the bytes) — the
// personal-graph twin of the server's asset_uploads row. Best effort: a
// missing entry only downgrades a replay to the metadata-compare reconcile.
function uploadPath(home, key) {
  return path.join(assetsRoot(home), "uploads", `${crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 32)}.json`);
}
function readUpload(home, key) {
  try {
    const j = JSON.parse(fs.readFileSync(uploadPath(home, key), "utf8"));
    return j && j.key === key ? j : null;
  } catch {
    return null;
  }
}
function writeUpload(home, key, id, digest) {
  try {
    const p = uploadPath(home, key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    require("./atomic-write.js").writeFileAtomic(p, `${JSON.stringify({ key, id, digest })}\n`);
  } catch {
    /* best effort */
  }
}

function gitBlobSha(buf) {
  return crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

function resultOf(meta, a, revision, status, warnings) {
  return {
    status,
    idempotency_key: meta.key,
    descriptor: { id: meta.id, revision },
    asset: {
      id: meta.id,
      uri: content.formatAssetUri({ id: meta.id, digest: a.digest }),
      digest: a.digest,
      media_type: a.media_type,
      bytes: a.size,
      width: a.width,
      height: a.height,
    },
    warnings,
  };
}

// importRemote({cfg, remote, file, opts}) -> the server's upload response. The
// file is measured locally first, so every verification refusal is answered
// here, before a byte is sent, with the server's own code; then it is streamed
// as the request body. A refusal the server answers mid-stream can surface as a
// connection reset, so a transport failure is retried ONCE under the same
// Idempotency-Key — the server reconciles a retry onto one descriptor — inside
// the same bounded budget as the busy re-sends.
//
// `opts.mediaType` uploads a NON-image object under that declared type (a
// candidate's git bundle, task-spor-worker-uploads-candidate-bundle-asset):
// the image rules (header sniff, pixel cap, trailer check) do not apply, the
// size cap and digest pin still do, and the server's descriptor is held to the
// digest, byte count and declared type — it has no dimensions to agree on.
async function importRemote({ cfg, remote, file, opts, timeoutMs = 120000 }) {
  checkInputFile(file);
  let meta;
  try {
    content.normalizeAssetMeta({ ...opts, key: "placeholder" });
  } catch (e) {
    throw metaError(e);
  }
  const declared = opts.mediaType ? String(opts.mediaType) : null;
  const measured = await measure(readSource(file), { expectedDigest: opts.digest || null, image: !declared });
  const a = declared ? { ...measured, media_type: declared, width: null, height: null } : measured;
  try {
    meta = importMeta(opts, a.digest, "local");
  } catch (e) {
    throw metaError(e);
  }
  const q = new URLSearchParams();
  // id rides only when the user named one: the server derives its own from its
  // tenant + the key otherwise (one descriptor per upload).
  if (opts.id) q.set("id", meta.id);
  for (const k of ["title", "summary", "alt", "project"]) if (meta[k]) q.set(k, meta[k]);
  q.set("digest", a.digest);
  // One bounded budget of re-sends for the whole import: the busy re-sends and
  // the one transport re-send share it (remote.exchange `transportRetries`),
  // and a salted-key send below spends what the first left, so an import makes
  // at most 1 + BUSY_MAX_RETRIES attempts (plus the salted key's own first
  // send) rather than stacking the retry layers. exchange() reports the
  // attempts it spent (a token refresh's re-send is not one).
  let attempts = 0;
  // A body stream opens its file LAZILY: an attempt refused before fetch ever
  // reads it (a refused connect) leaves a stream that opens after the import
  // has returned — and when the caller has removed the file by then (the
  // candidate publish stages its bundle in a scratch dir), its ENOENT is an
  // uncaught exception that kills the process. A consumed stream's error
  // still reaches fetch through its own reader, so the handler only
  // silences the abandoned one.
  const body = () => readSource(file).on("error", () => {});
  const send = (key) => remote.exchange(cfg, "POST", `/v1/assets?${q}`, {
    body,
    headers: { "content-type": a.media_type, "content-length": String(a.size), "idempotency-key": key },
    timeoutMs,
    transportRetries: 1,
    retries: Math.max(0, BUSY_MAX_RETRIES - Math.max(0, attempts - 1)),
  });
  let r = await send(meta.key);
  attempts = r.attempts || 1;
  // A derived key is shared by everyone importing the same image + metadata,
  // and the server binds a key to the principal that first used it. When it
  // belongs to someone else, fall back to a key salted with THIS caller's
  // identity — still stable across re-imports, so they keep replaying.
  if (!opts.key && r.status === 409 && r.json && r.json.error && r.json.error.code === "idempotency_key_reused") {
    r = await send(`${meta.key}.${principalSalt(cfg, remote)}`);
  }
  if (!r.ok) throw serverError(r, "upload");
  const j = r.json || {};
  const s = j.asset || {};
  // The server measured the same bytes: its descriptor must agree with ours.
  const drift = (declared ? ["digest", "media_type"] : ["digest", "media_type", "width", "height"]).filter((k) => s[k] !== a[k]);
  if (s.bytes !== a.size) drift.push("bytes");
  if (drift.length) throw new AssetError("verification_failed", `the server's descriptor disagrees with the local measurement on ${drift.join(", ")}`);
  return j;
}

// ---------------------------------------------------------------------------
// Describe / fetch / verify.

function describeLocal({ home, nodesDir, ref }) {
  const { id, pin } = ref;
  const file = path.join(nodesDir, `${id}.md`);
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    throw new AssetError("not_found", `no node '${id}'`);
  }
  const fm = require("../graph.js").parseFrontmatter(buf.toString("utf8"), `${id}.md`);
  const asset = assetView(id, fm, gitBlobSha(buf));
  if (!asset) throw new AssetError("not_an_asset", `'${id}' is not an asset descriptor`);
  if (pin && pin !== asset.digest) throw new AssetError("digest_mismatch", `'${id}' names ${asset.digest}, not ${pin}`);
  let available = false;
  try {
    available = fs.statSync(objectPath(home, asset.digest)).isFile();
  } catch {
    available = false;
  }
  return { asset, available };
}

async function describeRemote({ cfg, remote, ref }) {
  const q = ref.pin ? `?digest=${encodeURIComponent(ref.pin)}` : "";
  const r = await remote.get(cfg, `/v1/assets/${encodeURIComponent(ref.id)}${q}`, { timeoutMs: 15000 });
  if (!r.ok) throw serverError(r, "describe");
  const j = r.json || {};
  if (!j.asset || j.asset.id !== ref.id || !DIGEST_RE.test(String(j.asset.digest || ""))) {
    throw new AssetError("bad_response", `the server returned no descriptor for '${ref.id}'`);
  }
  if (ref.pin && j.asset.digest !== ref.pin) throw new AssetError("digest_mismatch", `'${ref.id}' names ${j.asset.digest}, not ${ref.pin}`);
  const a = j.asset;
  return {
    asset: {
      id: a.id, uri: a.uri, digest: a.digest, media_type: a.media_type, bytes: a.bytes, width: a.width, height: a.height,
      alt: a.alt ?? null, title: a.title ?? null, summary: a.summary ?? null, revision: a.revision ?? null,
    },
    available: !!j.available,
  };
}

// Where a fetch writes: --out (a file, or an existing directory to write the
// safe filename into), else the safe filename in cwd. "-" is stdout.
function outputPath(out, asset, cwd) {
  const name = content.assetFilename(asset.id, asset.digest, asset.media_type);
  if (out === "-") return "-";
  if (!out) return path.join(cwd, name);
  const abs = path.resolve(cwd, out);
  try {
    if (fs.statSync(abs).isDirectory()) return path.join(abs, name);
  } catch {
    /* a new file */
  }
  return abs;
}

// Stream `source` through verification into a temp file beside `dest`, then
// move it into place — so a failed or forged read never leaves an output
// file, and a reader never sees a partial one. Without --force the move is an
// EXCLUSIVE create (link, or a wx reservation renamed over — spool.js
// linkOrReserve), so a file that appears at `dest` while the bytes stream is
// refused, never clobbered; the up-front existence check only fails fast.
// --force renames over whatever is there. dest "-" verifies into a temp file
// and only then copies it to stdout.
async function writeVerified(source, asset, dest, { force = false, stdout = process.stdout } = {}) {
  const toStdout = dest === "-";
  if (!toStdout && !force && fs.existsSync(dest)) throw new AssetError("exists", `'${dest}' already exists (pass --force to replace it)`);
  const dir = toStdout ? fs.mkdtempSync(path.join(os.tmpdir(), "spor-asset-")) : path.dirname(dest);
  const tmp = path.join(dir, `.${path.basename(toStdout ? "out" : dest)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.part`);
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
  } catch (e) {
    if (toStdout) fs.rmSync(dir, { recursive: true, force: true });
    throw new AssetError("bad_request", `cannot write to '${toStdout ? "stdout" : path.dirname(dest)}': ${e.code || e.message}`);
  }
  let open = true;
  try {
    await verifyAgainst(source, asset, (c) => writeAll(fd, c));
    fs.fsyncSync(fd);
    assertWritten(fd, asset.bytes);
    fs.closeSync(fd);
    open = false;
    if (toStdout) {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(tmp);
        rs.on("error", reject);
        stdout.on("error", reject);
        rs.on("end", resolve);
        rs.pipe(stdout, { end: false });
      });
      return "-";
    }
    fs.chmodSync(tmp, 0o644);
    let placed;
    try {
      if (force) {
        replaceFileSync(tmp, dest); // another program may have the old file open
        placed = true;
      } else {
        placed = linkOrReserve(tmp, dest, { mode: 0o644 });
      }
    } catch (e) {
      throw new AssetError("bad_request", `cannot write '${dest}': ${e.code || e.message}`);
    }
    if (!placed) throw new AssetError("exists", `'${dest}' already exists (pass --force to replace it)`);
    return dest;
  } finally {
    if (open) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    if (toStdout) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function openLocal(home, asset) {
  const p = objectPath(home, asset.digest);
  try {
    if (!fs.statSync(p).isFile()) throw new Error("not a file");
  } catch {
    throw new AssetError("asset_unavailable", `the bytes of '${asset.id}' are not in this graph's asset store`);
  }
  return readSource(p);
}

// One verified byte read, local or remote: `dest` null verifies only; else the
// verified bytes land at `dest` (writeVerified).
async function readBytes({ mode, cfg, remote, home, described, dest, force, stdout, timeoutMs = 120000 }) {
  const asset = described.asset;
  const run = (source) => (dest == null ? verifyAgainst(source, asset) : writeVerified(source, asset, dest, { force, stdout }));
  if (mode !== "remote") return run(openLocal(home, asset));
  const { Readable } = require("stream");
  const q = `?digest=${encodeURIComponent(asset.digest)}${dest == null ? "" : "&download=1"}`;
  const r = await remote.exchange(cfg, "GET", `/v1/assets/${encodeURIComponent(asset.id)}/content${q}`, {
    timeoutMs,
    consume: (res) => {
      if (!res.body) throw new AssetError("bad_response", `the server sent no bytes for '${asset.id}'`);
      return run(Readable.fromWeb(res.body));
    },
  });
  if (!r.ok) throw serverError(r, "fetch");
  return r.value;
}

module.exports = {
  AssetError,
  measure,
  verifyAgainst,
  checkInputFile,
  assetsRoot,
  objectPath,
  excludeFromGit,
  stageLocal,
  parseRef,
  assetView,
  importKey,
  importLocal,
  importRemote,
  describeLocal,
  describeRemote,
  outputPath,
  writeVerified,
  readBytes,
};
