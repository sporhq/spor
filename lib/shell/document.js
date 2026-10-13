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
//      the new root revision, every part this job will create, whether the
//      home has a git object store) durably;
//   4. write the new parts (temp + fsync + rename); when the graph home is a
//      git repo, hash the replaced root, the new parts AND the new root into
//      its object store and check every id git answers against the revision
//      it must be — any git failure or mismatch refuses the publication with
//      the old root untouched (issue-spor-document-cli-root-written-before-
//      hashed), so a pinned read of either revision stays reproducible before
//      anything commits;
//   5. re-write the intent at stage `root` (naming the blobs it hashed), then
//      the root, LAST, by revision CAS;
//   6. remove the intent.
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
const { gitSpawn, gitOracle } = require("./git-exec.js");
const { claimSpoolJob, replaceFileSync } = require("./spool.js");

const REVISION_RE = /^[0-9a-f]{40}$/;
// A publication lock is honored this long, so a recycled pid cannot hold a
// document forever (a publication takes seconds).
const LOCK_TTL_MS = 30 * 60 * 1000;

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
// node is not a revision of this one). null when neither holds it; THROWS
// when git could not answer (a timeout, EAGAIN, a signal), since "the blob is
// not there" is an answer only git itself can give (the gitOracle hard-fail
// rule) and a refused read is honest where a not_found would not be.
function nodeAtRevision(nodesDir, id, revision) {
  const cur = readNodeFile(nodesDir, id);
  if (cur && cur.revision === revision) return cur;
  if (!inObjectStore(nodesDir, revision)) return null;
  const r = gitSpawn(path.dirname(nodesDir), ["cat-file", "-p", revision], { encoding: "buffer", timeout: 10000 });
  if (r.error || r.signal || r.status !== 0 || !Buffer.isBuffer(r.stdout)) {
    const stderr = Buffer.isBuffer(r.stderr) ? r.stderr.toString("utf8") : r.stderr;
    throw new Error(`git could not read ${revision}: ${gitWhy({ ...r, stderr })}`);
  }
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
  let read;
  try {
    read = readDocumentSnapshot(nodesDir, id, revision);
  } catch (e) {
    return refuse("internal", `could not read revision ${revision} of '${id}'`, { details: [String((e && e.message) || e).slice(0, 200)] });
  }
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
    replaceFileSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
  fsyncDir(path.dirname(file));
}

// Whether the graph home has a git object store to pin revisions in.
// -> {ok:true, store:bool} | {ok:false, why}. No repository (or no git binary)
// is `store:false` — such a home has no history to pin from; git failing to
// ANSWER is not, since a publication that skipped its hashes on a git error
// would overwrite a root no pinned read could recover.
function objectStore(nodesDir) {
  // "not a git repository" is matched as text (gitSpawn runs git in the C locale).
  const { state, result } = gitOracle(path.dirname(nodesDir), ["rev-parse", "--git-dir"], { missCodes: [128], timeout: 10000 });
  if (state === "hit") return { ok: true, store: true };
  if (result.error && result.error.code === "ENOENT") return { ok: true, store: false };
  if (state === "miss" && /not a git repository/i.test(String(result.stderr || ""))) return { ok: true, store: false };
  return { ok: false, why: `git could not say whether the graph home is a repository: ${gitWhy(result)}` };
}

function gitWhy(r) {
  return ((r.error && r.error.message) || String(r.stderr || "").trim() || (r.signal ? `killed by ${r.signal}` : `exit ${r.status}`)).slice(0, 200);
}

// Hash into the graph home's object store and check each id git answers is the
// revision it must be; throws on any git failure or mismatch. `files` are
// hashed as their raw bytes (--no-filters: a gitattributes filter would hash
// other bytes than the file a revision names); `data`, when given, is one more
// blob from memory — the new root, stored BEFORE its file replaces the old one.
// -> the hashed ids.
function hashObjects(nodesDir, { files = [], data = null }, want) {
  const home = path.dirname(nodesDir);
  const got = [];
  if (files.length) {
    const r = gitSpawn(home, ["hash-object", "-w", "--no-filters", "--", ...files], { timeout: 30000 });
    if (r.error || r.signal || r.status !== 0) throw new Error(`git hash-object failed: ${gitWhy(r)}`);
    got.push(...String(r.stdout || "").split("\n").filter(Boolean));
  }
  if (data != null) {
    const r = gitSpawn(home, ["hash-object", "-w", "--stdin"], { input: data, timeout: 30000 });
    if (r.error || r.signal || r.status !== 0) throw new Error(`git hash-object failed: ${gitWhy(r)}`);
    got.push(String(r.stdout || "").trim());
  }
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`git hash-object answered ${got.join(", ") || "nothing"}, not ${want.join(", ")}`);
  }
  return got;
}

// ---------- the per-document lock and the intent journal ----------

const intentPath = (journalDir, id) => path.join(journalDir, `${id}.publish.json`);
const lockPrefix = (id) => `${id}.lock-`;

// One holder per document: spool.js claimSpoolJob's per-contender lock
// (`<id>.lock-<pid>-<ts>-<ticks><rand>`, created by each contender and deleted only by
// it, ownership decided by a listing AFTER the create) — never a well-known
// path broken by check-then-unlink, under which two publishers could both end
// up holding it and one's recovery would delete the other's parts. A dead or
// expired holder is ignored; a live one is a conflict, never waited on.
// -> {ok:true, release} | refusal.
function acquireLock(journalDir, id) {
  fs.mkdirSync(journalDir, { recursive: true });
  const release = claimSpoolJob(journalDir, id, { prefix: lockPrefix(id), ttlMs: LOCK_TTL_MS });
  if (release) return { ok: true, release };
  return refuse("conflict", `another publication of '${id}' is in progress`, {
    details: ["wait for it to finish, then re-read the document and retry"],
  });
}

// Finish what a killed publication of `id` left behind (call it holding the
// lock). The intent names the root revision the job was about to land:
//   * the root IS that revision — it landed; its parts stand; drop the intent;
//   * the root is still the PRIOR revision (absent, for a create) and the
//     intent never reached stage `root` (the root write is only ever attempted
//     after it) — the new root provably never landed: remove
//     every part the job CREATED that still holds the bytes it wrote and that
//     the current root does not name (an adopted part was never the job's);
//   * the root is still the PRIOR revision under a stage-`root` intent — the
//     crash fell between the stage marker and the root's rename (or the new
//     root landed and its file was put back byte-for-byte since). The parts
//     are collected the same way unless the new root is in a COMMIT of the
//     graph home, the one place a revision that did land stays pinnable from;
//     a git that cannot answer keeps them (rootCommitted);
//   * anything else (the root moved through another door since) is not proof
//     either way — a revision that DID land may name those parts, and a pinned
//     read of it must stay whole — so the parts are kept (unreferenced, immutable
//     parts are harmless) and only the intent is dropped.
// -> null (nothing pending) | {id, outcome: "landed"|"rolled-back"|"kept", removed}.
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
  const curRev = cur ? cur.revision : null;
  if (intent && curRev === intent.root) {
    fs.unlinkSync(file);
    return { id, outcome: "landed", removed: [] };
  }
  const removed = [];
  // An intent from before the stage marker proved "never landed" by the new
  // root's absence from the object store; it was hashed only after its write.
  const atPrior = intent && curRev === (intent.prior ?? null);
  const neverWritten = atPrior && (intent.v >= 2
    ? intent.stage !== "root" || !rootCommitted(nodesDir, intent)
    : !inObjectStore(nodesDir, intent.root));
  const neverLanded = !!neverWritten;
  if (neverLanded) {
    const named = new Set(cur ? (content.readDocumentChain(cur, (pid) => readNodeFile(nodesDir, pid)) || { parts: [] }).parts : []);
    for (const p of Array.isArray(intent.fresh) ? intent.fresh : []) {
      if (!p || typeof p.id !== "string" || named.has(p.id)) continue;
      const part = readNodeFile(nodesDir, p.id);
      if (part && part.revision === p.revision) {
        fs.unlinkSync(path.join(nodesDir, `${p.id}.md`));
        removed.push(p.id);
      }
    }
    fsyncDir(nodesDir);
  }
  fs.unlinkSync(file);
  return { id, outcome: intent && !neverLanded ? "kept" : "rolled-back", removed };
}

// Whether a commit of the graph home holds `intent.root` (a stage-`root`
// intent whose root is back at the prior revision). A home with no object
// store has no history a revision could be pinned from; a git that cannot
// answer counts as committed, so recovery keeps the parts (the safe side).
function rootCommitted(nodesDir, intent) {
  if (!intent.store || typeof intent.root !== "string" || !REVISION_RE.test(intent.root)) return false;
  const { state, result } = gitOracle(path.dirname(nodesDir), ["log", "--all", "-1", "--format=%H", `--find-object=${intent.root}`], { timeout: 30000 });
  return state !== "hit" || String(result.stdout || "").trim() !== "";
}

// Whether the graph home's git object store holds `sha`. false where the
// object is absent or there is no store (or no git); THROWS when git could not answer, so
// a timeout or EAGAIN never reads as "not there" (gitOracle hard-fail).
function inObjectStore(nodesDir, sha) {
  if (typeof sha !== "string" || !REVISION_RE.test(sha)) return false;
  // `cat-file -e` exits 1, silently, for an absent object; 128 is "no
  // repository here" only when git says so.
  const { state, result } = gitOracle(path.dirname(nodesDir), ["cat-file", "-e", sha], { missCodes: [1, 128], timeout: 10000 });
  if (state === "hit") return true;
  // No git binary is no object store (objectStore's reading), not a failure.
  if (result.error && result.error.code === "ENOENT") return false;
  if (state === "miss" && (result.status === 1 || /not a git repository/i.test(String(result.stderr || "")))) return false;
  throw new Error(`git could not say whether ${sha} is stored: ${gitWhy(result)}`);
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
    } catch {
      // git could not answer; the intent stays for the next recovery
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
//   at(stage)         -> test seam, called at "journaled" | "parts" | "hashed" |
//                        "root"
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
    let recovered;
    try {
      recovered = recoverPublication(nodesDir, journalDir, id);
    } catch (e) {
      return refuse("internal", `an interrupted publication of '${id}' could not be recovered; nothing was published`, {
        id, details: [String((e && e.message) || e).slice(0, 200), "retry once git answers again"],
      });
    }
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

  const store = objectStore(nodesDir);
  if (!store.ok) {
    return refuse("internal", `publication of '${id}' refused; '${id}' still publishes its previous document`, { id, details: [store.why] });
  }
  const rootFile = path.join(nodesDir, `${id}.md`);
  const rootRevision = gitBlobSha(Buffer.from(gen.root));
  const intent = {
    v: 2, id, digest: gen.digest, prior: cur ? cur.root.revision : null, root: rootRevision,
    fresh: fresh.map((p) => ({ id: p.id, revision: gitBlobSha(Buffer.from(p.raw)) })),
    store: store.store, at: new Date().toISOString(),
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
    at("parts");
    // The replaced root, the new pieces AND the new root enter the object store
    // — every id checked — before the root file is replaced, so both revisions
    // stay pinnable; a git failure here leaves the old root standing.
    let hashed = [];
    if (store.store) {
      hashed = hashObjects(nodesDir, {
        files: [...(cur ? [rootFile] : []), ...fresh.map((p) => path.join(nodesDir, `${p.id}.md`))],
        data: gen.root,
      }, [...(cur ? [cur.root.revision] : []), ...intent.fresh.map((p) => p.revision), rootRevision]);
    }
    at("hashed");
    // The root, LAST, by revision CAS (the lock keeps every other publisher
    // out; this catches a hand edit since the checks above).
    const now = readNodeFile(nodesDir, id);
    if ((now ? now.revision : null) !== (cur ? cur.root.revision : null)) {
      const r = conflict(`'${id}' changed while publishing; re-read and retry`, now ? now.revision : undefined);
      rollBack("the root moved before it could be written");
      return r;
    }
    // Only from here may the root have been written: recovery reads a prior
    // root under a stage-`root` intent as not proof it never landed.
    writeDurable(intentPath(journalDir, id), JSON.stringify({ ...intent, stage: "root", hashed }, null, 2) + "\n");
    try {
      writeDurable(rootFile, gen.root);
    } catch (e) {
      // writeDurable throws only before (or at) its rename, so a root still at
      // the prior revision was never replaced: this process KNOWS what a
      // recovery reading the stage-`root` intent could not, and steps the
      // intent back so the rollback below removes the parts.
      if ((readNodeFile(nodesDir, id)?.revision ?? null) === intent.prior) {
        try { writeDurable(intentPath(journalDir, id), JSON.stringify(intent, null, 2) + "\n"); } catch { /* kept: safe */ }
      }
      throw e;
    }
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
