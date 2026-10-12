"use strict";
// The candidate bundle's TENANT ASSET copy (task-spor-worker-uploads-candidate-
// bundle-asset, dec-spor-candidate-bundle-as-tenant-asset): after a verified
// bundle publish, `spor work` in remote mode also uploads the bundle through
// the asset client (POST /v1/assets, digest-pinned) and records the asset ref
// on the candidate — or, when the upload fails, records why and no asset. The
// publish never depends on it. Driven against a stub asset server.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { gitEnv } = require("./helpers/git.js");

const candidate = require("../lib/kernel/candidate.js");
const content = require("../lib/kernel/content.js");
const publisher = require("../lib/shell/candidate-publish.js");
const assetLib = require("../lib/shell/asset.js");
const { candidateAssetUploader, approvalAssetFields } = require("../lib/shell/gate-deps.js");

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const shaBytes = (b) => `sha256:${crypto.createHash("sha256").update(b).digest("hex")}`;

function scratch(t, stem) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spor-${stem}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function producerRepo(t) {
  const dir = scratch(t, "cand-asset-repo");
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: gitEnv(), stdio: "ignore" });
  const g = (...args) => execFileSync("git", ["-C", dir, ...args], { env: gitEnv(), encoding: "utf8" }).trim();
  g("config", "user.email", "t@t");
  g("config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-q", "-m", "trusted");
  const base = g("rev-parse", "HEAD");
  g("checkout", "-q", "-b", "impl");
  fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
  g("add", "-A");
  g("commit", "-q", "-m", "work");
  return { dir, base, commit: g("rev-parse", "HEAD"), tree: g("rev-parse", "HEAD^{tree}") };
}

function mintFor(repo) {
  const r = candidate.mintCandidate(
    {
      repo: "spor",
      node_id: "task-x",
      commit: repo.commit,
      tree: repo.tree,
      base: { ref: "main", commit: repo.base, merge_base: repo.base },
      branch: "impl",
      clean: true,
      changed_paths: ["b.txt"],
    },
    { sha256 }
  );
  assert.deepStrictEqual(r.errors, [], r.errors.join("; "));
  return r.candidate;
}

// A stub of the server's upload door that takes a NON-image asset when
// `bundles` is on (the server half of the decision), refuses it as
// unsupported media otherwise (today's image-only server), and answers 413
// past `maxBytes` (the tenant's asset size limit).
async function startStub({ bundles = true, maxBytes = Infinity, forgeDigest = false } = {}) {
  const uploads = [];
  const journal = new Map();
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://stub");
    if (req.headers.authorization !== "Bearer tok") return send(res, 401, { error: { code: "unauthorized", message: "no" } });
    if (req.method !== "POST" || url.pathname !== "/v1/assets") return send(res, 404, { error: { code: "not_found", message: "no" } });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const key = req.headers["idempotency-key"];
    const sp = url.searchParams;
    uploads.push({ key, query: Object.fromEntries(sp), contentType: req.headers["content-type"], length: body.length });
    if (body.length > maxBytes) return send(res, 413, { error: { code: "too_large", message: `asset exceeds ${maxBytes} bytes` } });
    if (!bundles) return send(res, 415, { error: { code: "unsupported_media", message: "not a recognizable PNG, JPEG, GIF or WebP image" } });
    const digest = shaBytes(body);
    if (sp.get("digest") && sp.get("digest") !== digest) return send(res, 422, { error: { code: "digest_mismatch", message: "no" } });
    const replay = journal.has(key);
    const id = journal.get(key) || `art-asset-${sha256(key).slice(0, 16)}`;
    journal.set(key, id);
    const served = forgeDigest ? `sha256:${"0".repeat(64)}` : digest;
    return send(res, replay ? 200 : 201, {
      status: replay ? "replayed" : "created",
      idempotency_key: key,
      descriptor: { id, revision: "f".repeat(40) },
      asset: { id, uri: content.formatAssetUri({ id, digest: served }), digest: served, media_type: req.headers["content-type"], bytes: body.length, width: null, height: null },
      warnings: [],
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return { url, uploads, close: () => new Promise((r) => srv.close(r)) };
}

const remoteCfg = (url) => ({ mode: () => "remote", server: () => url, token: () => "tok", get: () => undefined });

async function publishWith(t, uploadAsset) {
  const repo = producerRepo(t);
  const store = pathToFileURL(scratch(t, "cand-asset-store")).href;
  const cand = mintFor(repo);
  const r = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "bundle", bundleStore: store, uploadAsset });
  return { repo, store, cand, r };
}

test("remote: a verified bundle is uploaded as a digest-pinned tenant asset and its ref recorded on the candidate", async (t) => {
  const stub = await startStub();
  t.after(stub.close);
  const upload = candidateAssetUploader(remoteCfg(stub.url), { slug: "spor", nodeId: "task-x" });
  const { cand, r } = await publishWith(t, upload);
  assert.strictEqual(r.ok, true, r.reason);
  const ref = r.candidate.reference;
  const a = r.candidate.asset;
  assert.ok(a, "the asset ref rides the candidate");
  assert.strictEqual(r.candidate.asset_error, undefined);
  // The asset IS the published bundle: same digest, same byte count.
  assert.strictEqual(a.digest, `sha256:${ref.sha256}`);
  assert.strictEqual(a.bytes, ref.bytes);
  assert.strictEqual(a.media_type, publisher.BUNDLE_MEDIA_TYPE);
  assert.strictEqual(a.uri, content.formatAssetUri({ id: a.id, digest: a.digest }));
  assert.ok(a.uploaded_at);
  // The upload was digest-pinned, typed as a git bundle, and captioned.
  assert.strictEqual(stub.uploads.length, 1);
  const u = stub.uploads[0];
  assert.strictEqual(u.contentType, "application/x-git-bundle");
  assert.strictEqual(u.query.digest, a.digest);
  assert.strictEqual(u.query.project, "spor");
  assert.match(u.query.title, new RegExp(cand.candidate_id));
  assert.match(u.key, /^spor-candidate\.[0-9a-f]{40}$/);
  // The file:// reference is unchanged — the asset is an addition, not a replacement.
  assert.strictEqual(ref.kind, "bundle");
  assert.ok(ref.locator.startsWith("file://"));
  assert.strictEqual(candidate.candidateSubmitted(r.candidate), true);
});

test("remote: re-publishing the same candidate replays onto the same asset (one key per candidate + digest)", async (t) => {
  const stub = await startStub();
  t.after(stub.close);
  const upload = candidateAssetUploader(remoteCfg(stub.url), { slug: "spor" });
  const repo = producerRepo(t);
  const store = pathToFileURL(scratch(t, "cand-asset-store")).href;
  const first = await publisher.publishCandidate(mintFor(repo), { cwd: repo.dir, publish: "bundle", bundleStore: store, uploadAsset: upload });
  const again = await publisher.publishCandidate(mintFor(repo), { cwd: repo.dir, publish: "bundle", bundleStore: store, uploadAsset: upload });
  assert.strictEqual(first.ok && again.ok, true);
  assert.strictEqual(stub.uploads.length, 2);
  assert.strictEqual(stub.uploads[0].key, stub.uploads[1].key);
  assert.strictEqual(again.candidate.asset.id, first.candidate.asset.id);
});

test("a server that takes no bundle assets: the publish stands, asset_error says why, and no asset is recorded", async (t) => {
  const stub = await startStub({ bundles: false });
  t.after(stub.close);
  const { r } = await publishWith(t, candidateAssetUploader(remoteCfg(stub.url), { slug: "spor" }));
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(candidate.candidateSubmitted(r.candidate), true);
  assert.strictEqual(r.candidate.asset, undefined);
  assert.strictEqual(r.candidate.asset_error.code, "unsupported_media");
  assert.match(r.candidate.asset_error.reason, /could not be uploaded to the tenant asset store/);
  assert.strictEqual(r.candidate.asset_error.digest, `sha256:${r.candidate.reference.sha256}`);
});

test("a bundle over the server's asset size limit is recorded as too_large, never blocking the publish", async (t) => {
  const stub = await startStub({ maxBytes: 10 });
  t.after(stub.close);
  const { r } = await publishWith(t, candidateAssetUploader(remoteCfg(stub.url), { slug: "spor" }));
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.candidate.asset, undefined);
  assert.strictEqual(r.candidate.asset_error.code, "too_large");
});

test("a dead server, or an uploader that throws, records asset_error and the publish stands", async (t) => {
  const dead = candidateAssetUploader(remoteCfg("http://127.0.0.1:1"), { slug: "spor" });
  const a = await publishWith(t, dead);
  assert.strictEqual(a.r.ok, true, a.r.reason);
  assert.ok(a.r.candidate.asset_error, "an outage is recorded");
  assert.strictEqual(a.r.candidate.asset, undefined);

  const b = await publishWith(t, async () => {
    throw new Error("boom");
  });
  assert.strictEqual(b.r.ok, true, b.r.reason);
  assert.match(b.r.candidate.asset_error.reason, /boom/);
});

test("a server asset whose digest is not the bundle's is not recorded as the bundle's asset", async (t) => {
  // importRemote's own drift check refuses it before the publisher sees it.
  const stub = await startStub({ forgeDigest: true });
  t.after(stub.close);
  const { r } = await publishWith(t, candidateAssetUploader(remoteCfg(stub.url), { slug: "spor" }));
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.candidate.asset, undefined);
  assert.strictEqual(r.candidate.asset_error.code, "verification_failed");
  // And the publisher's own check holds even for an uploader that skips it.
  const forged = await publishWith(t, async () => ({ ok: true, asset: { id: "art-asset-x", digest: `sha256:${"1".repeat(64)}` } }));
  assert.strictEqual(forged.r.candidate.asset, undefined);
  assert.match(forged.r.candidate.asset_error.reason, /not the bundle's/);
});

test("local mode uploads nothing: no uploader, and the candidate carries no asset fields (byte-identical)", async (t) => {
  assert.strictEqual(candidateAssetUploader({ mode: () => "local" }), null);
  const { r } = await publishWith(t, null);
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual("asset" in r.candidate, false);
  assert.strictEqual("asset_error" in r.candidate, false);
});

test("a failed bundle publish uploads nothing", async (t) => {
  let called = 0;
  const repo = producerRepo(t);
  const r = await publisher.publishCandidate(mintFor(repo), {
    cwd: repo.dir,
    publish: "bundle",
    bundleStore: null,
    bundleStoreReason: "no store",
    uploadAsset: async () => {
      called++;
      return { ok: true, asset: {} };
    },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(called, 0);
});

test("importRemote with a declared mediaType uploads a non-image under that type and checks digest + bytes", async (t) => {
  const stub = await startStub();
  t.after(stub.close);
  const dir = scratch(t, "cand-asset-blob");
  const file = path.join(dir, "x.bundle");
  fs.writeFileSync(file, "# v2 git bundle\nnot an image\n");
  const r = await assetLib.importRemote({ cfg: remoteCfg(stub.url), remote: require("../lib/remote.js"), file, opts: { key: "spor-candidate.test0001", mediaType: "application/x-git-bundle" } });
  assert.strictEqual(r.asset.media_type, "application/x-git-bundle");
  assert.strictEqual(r.asset.digest, shaBytes(fs.readFileSync(file)));
  // Without the declared type the image rules still apply, before any send.
  await assert.rejects(
    assetLib.importRemote({ cfg: remoteCfg(stub.url), remote: require("../lib/remote.js"), file, opts: { key: "spor-candidate.test0002" } }),
    (e) => e.code === "unsupported_media"
  );
  assert.strictEqual(stub.uploads.length, 1);
});

test("the approval item binds the candidate's asset only when it is the judged commit", () => {
  const head = "a".repeat(40);
  const asset = { id: "art-asset-1", uri: `spor-asset:art-asset-1@sha256:${"b".repeat(64)}`, digest: `sha256:${"b".repeat(64)}` };
  assert.deepStrictEqual(approvalAssetFields({ candidate_id: "cand-1", commit: head, asset }, head.toUpperCase()), {
    candidate_id: "cand-1",
    candidate_asset: asset.uri,
    candidate_asset_digest: asset.digest,
  });
  assert.strictEqual(approvalAssetFields({ candidate_id: "cand-1", commit: "c".repeat(40), asset }, head), null);
  assert.strictEqual(approvalAssetFields({ candidate_id: "cand-1", commit: head }, head), null);
  assert.strictEqual(approvalAssetFields(null, head), null);
  assert.strictEqual(approvalAssetFields({ commit: head, asset: { ...asset, digest: "nope" } }, head), null);
});
