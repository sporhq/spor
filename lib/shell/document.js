"use strict";
// shell/document.js — complete document IO over a LOCAL graph home
// (task-spor-chatgpt-document-cli). The local twin of spor-server's document
// owner (server/documents.ts + store.publishDocument, contract in spor-server
// docs/DOCUMENT-GENERATIONS.md): `spor get <id> --document` and `spor
// put-document` call getDocument / putDocument here in local mode and the
// server's GET|PUT /v1/documents/{id} in remote mode, and both answer with the
// same shapes, so a script never branches on mode (norm-spor-cli-mode-parity).
// The pieces themselves — the content-addressed part ids, the exact-body
// digest, the chain read and its completeness verdicts — are the kernel's
// (lib/kernel/content.js documentGeneration / readDocumentChain), ported from
// the server byte-for-byte; this module only does the I/O around them.
//
// Publication is the server's order — parts first, the root LAST by revision
// CAS — made crash-recoverable on a plain filesystem with no store FIFO and no
// git commit to lean on:
//
//   1. under a per-document LOCK (journal/documents/<id>.lock: pid + start
//      ticks; a dead holder's lock is broken), finish any publication a killed
//      process left (recoverPublication, below);
//   2. build the generation; reconcile (a root already publishing exactly
//      this source answers `unchanged`); check the caller's snapshot — the
//      root revision and, for a legacy spill, every part revision; adopt an
//      existing part only on an exact body/doc_generation/continuation_of match;
//      validate every new piece against the graph it would leave behind;
//   3. write the INTENT (journal/documents/<id>.publish.json: the prior and
//      the new root revision, every part this job will create) durably;
//   4. write the new parts (temp + fsync + rename), then the root, LAST, by
//      revision CAS; when the graph home is a git repo the pieces and the
//      replaced root are also hashed into its object store, so a pinned read of
//      either revision stays reproducible before anything commits;
//   5. remove the intent.
//
// A process death anywhere leaves either the old root (the intent names parts
// nobody references — the next publication's recovery removes them) or the new
// root naming parts that already stand (recovery just drops the intent). Every
// read starts at the root, so no reader ever sees a mix. Zero dependencies:
// node builtins and (optionally) the git binary.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const content = require("../kernel/content.js");
const frontmatter = require("../kernel/frontmatter.js");
const { gitSpawn } = require("./git-exec.js");
const { mintIdentity, isOurProcess } = require("./process-identity.js");

const REVISION_RE = /^[0-9a-f]{40}$/;
// A lock whose holder cannot be verified (no start ticks off Linux) is still
// honored this long, so a recycled pid cannot hold a document forever.
const LOCK_TTL_MS = 10 * 60 * 1000;

// sha1("blob <len>\0<bytes>") — exactly `git hash-object`, the revision every
// read returns and every update CASes on (bin/spor.js gitBlobSha's twin).
function gitBlobSha(buf) {
  const h = crypto.createHash("sha1");
  h.update(`blob ${buf.length}\0`);
  h.update(buf);
  return h.digest("hex");
}

function refuse(code, message, extra = {}) {
  return { ok: false, code, message, details: [], ...extra };
}

function parse(raw, id) {
  try {
    return frontmatter.parseFrontmatter(raw, `${id}.md`);
  } catch {
    return null;
  }
}

// One node as it stands: {id, raw, frontmatter, revision} | null.
function readNodeFile(nodesDir, id) {
  let buf;
  try {
    buf = fs.readFileSync(path.join(nodesDir, `${id}.md`));
  } catch {
    return null;
  }
  const raw = buf.toString("utf8");
  return { id, raw, frontmatter: parse(raw, id) || {}, revision: gitBlobSha(buf) };
}

// The root as one revision published it: the current file when it IS that
// revision, else the blob from the graph home's git object store — accepted
// only when its bytes hash to `revision` and it names `id` (a blob of another
// node is not a revision of this one). null when neither holds it.
function nodeAtRevision(nodesDir, id, revision) {
  const cur = readNodeFile(nodesDir, id);
  if (cur && cur.revision === revision) return cur;
  const r = gitSpawn(path.dirname(nodesDir), ["cat-file", "blob", revision], { encoding: "buffer", timeout: 10000 });
  if (r.error || r.status !== 0 || !Buffer.isBuffer(r.stdout)) return null;
  if (gitBlobSha(r.stdout) !== revision) return null;
  const raw = r.stdout.toString("utf8");
  const f = parse(raw, id);
  if (!f || f.id !== id) return null;
  return { id, raw, frontmatter: f, revision };
}

// One exact document as read, with the revisions that pin it
// (store-persist.ts readDocumentSnapshot). null when the root does not exist
// (or, pinned, that revision does not name it).
function readDocumentSnapshot(nodesDir, id, revision = null) {
  const root = revision == null ? readNodeFile(nodesDir, id) : nodeAtRevision(nodesDir, id, revision);
  if (!root) return null;
  const doc = content.readDocumentChain(root, (pid) => readNodeFile(nodesDir, pid), { pinned: revision != null });
  if (!doc) return null;
  const parts = doc.parts.map((pid) => {
    const p = readNodeFile(nodesDir, pid);
    return { id: pid, revision: p ? p.revision : null };
  });
  const f = root.frontmatter || {};
  const managed = f[content.DOC_DIGEST_KEY] != null || f[content.DOC_BYTES_KEY] != null;
  const snapshot = { root: id, revision: root.revision };
  if (managed) {
    snapshot[content.DOC_DIGEST_KEY] = String(f[content.DOC_DIGEST_KEY]);
    snapshot[content.DOC_BYTES_KEY] = Number(f[content.DOC_BYTES_KEY]);
  }
  snapshot.parts = parts;
  return { root, doc, managed, snapshot };
}

// The read core (documents.ts getDocument). -> {ok:true, document} | refusal.
function getDocument(nodesDir, { id, revision = null }) {
  if (typeof id !== "string" || !id) return refuse("bad_request", "expected a document id");
  if (revision != null && (typeof revision !== "string" || !REVISION_RE.test(revision))) {
    return refuse("bad_request", "revision must be a 40-hex root revision from get_document or get_node");
  }
  const read = readDocumentSnapshot(nodesDir, id, revision);
  if (!read) {
    return revision == null
      ? refuse("not_found", `document '${id}' not found`)
      : refuse("not_found", `revision ${revision} does not name a revision of '${id}'`);
  }
  if (read.doc.history_unavailable) {
    return refuse("not_found",
      `'${id}' at ${revision} is a legacy spill whose continuation parts are mutable; that revision's exact text cannot be reproduced`,
      { details: ["read the current document, or publish it with put_document so later revisions stay reproducible"] });
  }
  return { ok: true, document: content.documentAnswer(read.root, read.doc, read.snapshot) };
}

// ---------- durable writes ----------

function fsyncDir(dir) {
  // Best-effort: a directory cannot be opened for fsync on every platform.
  let fd = null;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    /* not supported here */
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

// temp + fsync + rename (+ the directory), so a reader never sees a torn file
// and a crash after the rename keeps the bytes.
function writeDurable(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(tmp, "wx");
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
  fsyncDir(path.dirname(file));
}

// Hash files into the graph home's git object store, when there is one, so a
// revision a root names (or named) can be pinned before anything commits.
// Best-effort: a home that is not a git repo has no history to pin from.
function hashObjects(nodesDir, files) {
  if (!files.length) return;
  gitSpawn(path.dirname(nodesDir), ["hash-object", "-w", "--", ...files], { timeout: 30000 });
}

// ---------- the per-document lock and the intent journal ----------

const lockPath = (journalDir, id) => path.join(journalDir, `${id}.lock`);
const intentPath = (journalDir, id) => path.join(journalDir, `${id}.publish.json`);

function holderLive(lock) {
  if (!lock || !Number.isInteger(lock.pid)) return false;
  if (lock.pid === process.pid) return true;
  const { reallyAlive, identityKnown } = isOurProcess(lock.pid, lock.ticks);
  if (!reallyAlive) return false;
  return identityKnown || Date.now() - Number(lock.at || 0) < LOCK_TTL_MS;
}

// -> {ok:true, release} | refusal. One retry after breaking a dead holder's
// lock; a live holder is a conflict, never waited on.
function acquireLock(journalDir, id) {
  fs.mkdirSync(journalDir, { recursive: true });
  const file = lockPath(journalDir, id);
  const token = crypto.randomBytes(8).toString("hex");
  const body = JSON.stringify({ ...mintIdentity(), at: Date.now(), token });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: "wx" });
      return {
        ok: true,
        release: () => {
          try {
            if (JSON.parse(fs.readFileSync(file, "utf8")).token === token) fs.unlinkSync(file);
          } catch { /* already gone */ }
        },
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let held = null;
    try { held = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* torn or gone: dead */ }
    if (holderLive(held)) {
      return refuse("conflict", `another publication of '${id}' is in progress (pid ${held.pid})`, {
        details: ["wait for it to finish, then re-read the document and retry"],
      });
    }
    try { fs.unlinkSync(file); } catch { /* raced */ }
  }
  return refuse("conflict", `could not take the publication lock for '${id}'`, { details: [file] });
}

// Finish what a killed publication of `id` left behind (call it holding the
// lock). The intent names the root revision the job was about to land:
//   * the root IS that revision — it landed; its parts stand; drop the intent;
//   * anything else — it never landed; remove every part the job CREATED that
//     still holds the bytes it wrote and that the current root does not name
//     (an adopted part was never the job's), then drop the intent.
// -> null (nothing pending) | {id, outcome: "landed"|"rolled-back", removed}.
function recoverPublication(nodesDir, journalDir, id) {
  const file = intentPath(journalDir, id);
  let intent;
  try {
    intent = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    intent = null; // torn: the intent was never durable, so no part was written after it
  }
  const cur = readNodeFile(nodesDir, id);
  if (intent && cur && cur.revision === intent.root) {
    fs.unlinkSync(file);
    return { id, outcome: "landed", removed: [] };
  }
  const named = new Set(cur ? (content.readDocumentChain(cur, (pid) => readNodeFile(nodesDir, pid)) || { parts: [] }).parts : []);
  const removed = [];
  for (const p of (intent && Array.isArray(intent.fresh)) ? intent.fresh : []) {
    if (!p || typeof p.id !== "string" || named.has(p.id)) continue;
    const part = readNodeFile(nodesDir, p.id);
    if (part && part.revision === p.revision) {
      fs.unlinkSync(path.join(nodesDir, `${p.id}.md`));
      removed.push(p.id);
    }
  }
  fsyncDir(nodesDir);
  fs.unlinkSync(file);
  return { id, outcome: "rolled-back", removed };
}

// Every pending intent in the journal, each under its own lock (a live
// publication's is skipped). -> [{id, outcome, removed}].
function recoverAll(nodesDir, journalDir) {
  let names = [];
  try { names = fs.readdirSync(journalDir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".publish.json")) continue;
    const id = n.slice(0, -".publish.json".length);
    const lock = acquireLock(journalDir, id);
    if (!lock.ok) continue;
    try {
      const r = recoverPublication(nodesDir, journalDir, id);
      if (r) out.push(r);
    } finally {
      lock.release();
    }
  }
  return out;
}

// ---------- put_document ----------

// The write core (documents.ts putDocument + store.publishDocument). `node` is
// the whole source; `snapshot` the one getDocument returned (required to
// update, absent to create). Injected:
//   prefixesFor(type) -> the registry's id prefixes (generationBaseFor)
//   validate(pieces)  -> {errors: string[], warnings: string[]}: judge every
//                        new piece ({id, raw}) against the graph it leaves
//   at(stage)         -> test seam, called at "journaled" | "parts" | "root"
// -> {ok:true, status, id, revision, generation, parts, warnings, snapshot,
//     recovered?} | refusal.
function putDocument(nodesDir, { node, snapshot = null, journalDir, prefixesFor = () => [], validate = () => ({ errors: [], warnings: [] }), at = () => {}, today } = {}) {
  if (typeof node !== "string" || !node) return refuse("bad_request", "expected `node`: the whole document source (frontmatter + body)");
  if (snapshot != null) {
    if (typeof snapshot !== "object" || Array.isArray(snapshot)) return refuse("bad_request", "`snapshot` must be the snapshot object get_document returned");
    const errs = content.validateDocumentSnapshot(snapshot);
    if (errs.length) return { ...refuse("bad_request", "invalid document snapshot"), details: errs };
  }
  let type = null;
  try { type = frontmatter.parseFrontmatter(node, "incoming.md").type; } catch { /* documentGeneration reports it */ }
  const gen = content.documentGeneration(node, { prefixes: type ? prefixesFor(type) : [], ...(today ? { today } : {}) });
  if (!gen.ok) return { ...gen, details: gen.details || [] };
  const id = gen.id;
  if (snapshot && snapshot.root !== id) return refuse("bad_request", `the snapshot is of '${snapshot.root}', not '${id}'`);

  const lock = acquireLock(journalDir, id);
  if (!lock.ok) return lock;
  try {
    const recovered = recoverPublication(nodesDir, journalDir, id);
    const r = publish(nodesDir, journalDir, gen, snapshot, { validate, at });
    if (!r.ok) return r;
    const read = readDocumentSnapshot(nodesDir, r.id, r.revision);
    return { ...r, ...(read ? { snapshot: read.snapshot } : {}), ...(recovered ? { recovered } : {}) };
  } finally {
    lock.release();
  }
}

function publish(nodesDir, journalDir, gen, snapshot, { validate, at }) {
  const id = gen.id;
  const target = readNodeFile(nodesDir, id);
  const tfm = (target && target.frontmatter) || {};
  if (content.managedDocumentRole(tfm) === "part" || tfm[content.CONTINUATION_STAMP] != null) {
    const host = tfm[content.CONTINUATION_STAMP];
    return refuse("conflict", `'${id}' is a continuation part${host ? ` of '${host}'` : ""}, not a document root; it is never published on its own`, {
      id, details: [host ? `read and publish the document at its root: get_document / put_document on '${host}'` : "publish the document at its root"],
    });
  }
  const conflict = (message, revision, hint = "re-read the document with get_document and retry against its snapshot") =>
    refuse("conflict", message, { id, details: [hint], ...(revision ? { revision } : {}) });
  const genParts = gen.parts.map((p) => p.id);

  // Reconcile, then the base checks, against the document as it stands.
  const cur = readDocumentSnapshot(nodesDir, id);
  if (cur) {
    if (String(cur.root.frontmatter[content.DOC_DIGEST_KEY] ?? "") === gen.digest && cur.doc.complete &&
        JSON.stringify(cur.doc.parts) === JSON.stringify(genParts) && cur.root.raw === gen.root) {
      return { ok: true, status: "unchanged", id, revision: cur.root.revision, generation: gen.digest, parts: genParts, warnings: [] };
    }
    if (!snapshot) return conflict(`document '${id}' already exists; pass the snapshot you read to update it`, cur.root.revision);
    if (snapshot.revision !== cur.root.revision) return conflict(`stale revision for '${id}'; re-read and retry`, cur.root.revision);
    const want = JSON.stringify((snapshot.parts || []).map((p) => [p.id, p.revision]));
    const have = JSON.stringify(cur.snapshot.parts.map((p) => [p.id, p.revision]));
    if (want !== have) {
      return conflict(`the continuation parts of '${id}' changed since the snapshot was read (${cur.managed ? "generation" : "legacy spill"} part vector differs)`, cur.root.revision);
    }
  } else if (snapshot) {
    return refuse("not_found", `document '${id}' does not exist; create it without a snapshot`, { id });
  }

  // Adopt an existing part only by content; every new piece is validated
  // against the graph it would leave behind, with nothing written.
  const fresh = [];
  for (const p of gen.parts) {
    const stored = readNodeFile(nodesDir, p.id);
    if (stored) {
      const sfm = stored.frontmatter || {};
      const sb = frontmatter.splitDocument(stored.raw);
      if (!sb || sb.body !== frontmatter.splitDocument(p.raw).body ||
          String(sfm[content.DOC_GENERATION_KEY] ?? "") !== gen.digest || String(sfm[content.CONTINUATION_STAMP] ?? "") !== id) {
        return conflict(`generation part '${p.id}' exists with other content; refusing to publish '${id}' over it`, undefined,
          `if '${p.id}' was edited in place, restore its published bytes from git history; generation parts are immutable`);
      }
      continue;
    }
    fresh.push(p);
  }
  const v = validate([...fresh, { id, raw: gen.root }]);
  if (v.errors && v.errors.length) return refuse("invalid_node", `document '${id}' refused`, { id, details: v.errors });

  const rootFile = path.join(nodesDir, `${id}.md`);
  const rootRevision = gitBlobSha(Buffer.from(gen.root));
  const intent = {
    id, digest: gen.digest, prior: cur ? cur.root.revision : null, root: rootRevision,
    fresh: fresh.map((p) => ({ id: p.id, revision: gitBlobSha(Buffer.from(p.raw)) })),
    at: new Date().toISOString(),
  };
  writeDurable(intentPath(journalDir, id), JSON.stringify(intent, null, 2) + "\n");
  at("journaled");
  const rollBack = (why) => {
    let removed = [];
    try { removed = (recoverPublication(nodesDir, journalDir, id) || {}).removed || []; } catch (e) { why = `${why}; rollback stopped: ${e.message}`; }
    return refuse("internal", `publication of '${id}' failed; '${id}' still publishes its previous document`, {
      id, details: [why, ...(removed.length ? [`rolled back the part(s) already written: ${removed.join(", ")}`] : [])],
    });
  };
  try {
    for (const p of fresh) writeDurable(path.join(nodesDir, `${p.id}.md`), p.raw);
    // The replaced root and the new pieces enter the object store before the
    // root names them, so both revisions stay pinnable.
    hashObjects(nodesDir, [...(cur ? [rootFile] : []), ...fresh.map((p) => path.join(nodesDir, `${p.id}.md`))]);
    at("parts");
    // The root, LAST, by revision CAS (the lock keeps every other publisher
    // out; this catches a hand edit since the checks above).
    const now = readNodeFile(nodesDir, id);
    if ((now ? now.revision : null) !== (cur ? cur.root.revision : null)) {
      const r = conflict(`'${id}' changed while publishing; re-read and retry`, now ? now.revision : undefined);
      rollBack("the root moved before it could be written");
      return r;
    }
    writeDurable(rootFile, gen.root);
    hashObjects(nodesDir, [rootFile]);
    at("root");
  } catch (e) {
    if (readNodeFile(nodesDir, id)?.revision === rootRevision) {
      // The root landed; only the bookkeeping failed. Recovery drops the intent.
      try { recoverPublication(nodesDir, journalDir, id); } catch { /* the next publication's recovery will */ }
    } else {
      return rollBack(String((e && e.message) || e).slice(0, 200));
    }
  }
  // The root stands; an intent left behind is dropped by the next recovery.
  try { fs.unlinkSync(intentPath(journalDir, id)); } catch { /* gone, or the next recovery's */ }
  return {
    ok: true, status: cur ? "updated" : "created", id, revision: rootRevision,
    generation: gen.digest, parts: genParts, warnings: v.warnings || [],
  };
}

module.exports = {
  gitBlobSha,
  readNodeFile,
  nodeAtRevision,
  readDocumentSnapshot,
  getDocument,
  putDocument,
  recoverPublication,
  recoverAll,
  LOCK_TTL_MS,
};
