// record-document-goldens.js — re-record test/fixtures/document-generations/
// goldens.json from spor-server's OWN document builder and reader, the oracle
// lib/kernel/content.js's port is pinned to (test/document.test.js "goldens").
// Not a test: run it by hand against a server checkout when the server's
// documentGeneration / readDocument moves, and commit the result.
//
//   node test/helpers/record-document-goldens.js ../spor-server
//
// The server checkout must hold EMITTED .js current with its .ts (its build
// emits in place, and a stale emit records stale verdicts): e.g. `git archive`
// it to a scratch dir, symlink node_modules, run `tsc -p
// server/tsconfig.build.json` there, and pass SPOR_SERVER_SHA=<sha> to name
// the commit. Outputs are stored as sha256 digests (the inputs are cases.js),
// so the golden stays small. It writes nothing else: the reader runs over an
// in-memory fake store (getNode / getNodeAtRevision), never a graph home.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const serverDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "..", "..", "spor-server"));
const sp = require(path.join(serverDir, "server", "store-persist.js"));
const graphLib = require(path.join(__dirname, "..", "..", "lib", "graph.js"));
const { gitBlobSha } = require(path.join(__dirname, "..", "..", "lib", "shell", "document.js"));
const CASES = require(path.join(__dirname, "..", "fixtures", "document-generations", "cases.js"));

const PREFIXES = { decision: ["dec-"], artifact: ["art-"], task: ["task-"], person: ["person-"] };
const registry = { prefixesFor: (t) => PREFIXES[t] || [] };
const h = (t) => require("node:crypto").createHash("sha256").update(String(t), "utf8").digest("hex");
const node = (raw) => ({ raw, frontmatter: graphLib.parseFrontmatter(raw, "x.md"), revision: gitBlobSha(Buffer.from(raw)) });

const generations = CASES.generations.map((c) => {
  const self = { graph: { nodes: {}, registry } };
  const r = sp.documentGeneration(self, c.source);
  return { name: c.name, expect: r.ok
    ? { ok: true, id: r.id, digest: r.digest, bytes: r.bytes, root_sha256: h(r.root), parts: r.parts.map((p) => ({ id: p.id, sha256: h(p.raw) })) }
    : { ok: false, message: r.message } };
});

const reads = CASES.reads().map((c) => {
  const files = new Map(Object.entries(c.files).map(([id, raw]) => [id, node(raw)]));
  const pinned = c.pinned ? node(c.pinned) : null;
  const self = {
    getNode: (id) => files.get(id) || null,
    getNodeAtRevision: (id, rev) => (pinned && id === c.root && rev === pinned.revision ? pinned : null),
  };
  const r = sp.readDocument(self, c.root, pinned ? pinned.revision : null);
  return { name: c.name, expect: r && { ...r, body: undefined, body_sha256: h(r.body) } };
});

const sha = process.env.SPOR_SERVER_SHA || spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: serverDir, encoding: "utf8" }).stdout.trim();
const out = path.join(__dirname, "..", "fixtures", "document-generations", "goldens.json");
fs.writeFileSync(out, JSON.stringify({ recorded_from: `spor-server@${sha}`, generations, reads }, null, 2) + "\n");
console.log(`wrote ${generations.length} generation + ${reads.length} read goldens from spor-server@${sha}`);
