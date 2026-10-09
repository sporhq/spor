// document-mutation-guards.test.js — local mode enforces the managed-document
// invariants on every ordinary write door (issue-spor-local-mode-document-
// mutation-guards), in parity with spor-server's reserved-fields.js doc_*
// durability fields and write-pipeline.ts managedDocumentDenied: a managed
// root's body changes only through put-document, the doc_* stamps are the
// owner's alone, and a generation part is immutable. Plus the near-cap lint
// staying quiet on generation pieces. Scratch homes only.

require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { hermeticEnv } = require("./helpers/env.js");

const content = require("../lib/kernel/content.js");
const documentShell = require("../lib/shell/document.js");
const graphLib = require("../lib/graph.js");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

function source(id, { paras = 400, edit = "" } = {}) {
  const ps = [];
  for (let i = 1; i <= paras; i++) ps.push(`Paragraph ${i}${i === 3 ? edit : ""} — text.`);
  return `---\nid: ${id}\ntype: artifact\ntitle: Doc ${id}\nsummary: A long document.\nstatus: active\ndate: 2026-10-09\n---\n\n${ps.join("\n\n")}\n`;
}
function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "spor-docguard-"));
  fs.mkdirSync(path.join(h, "nodes"));
  return h;
}
const nodes = (h) => path.join(h, "nodes");
const file = (h, id) => path.join(nodes(h), `${id}.md`);
const read = (h, id) => fs.readFileSync(file(h, id), "utf8");
const revision = (h, id) => documentShell.gitBlobSha(fs.readFileSync(file(h, id)));
const cli = (h, args, input) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: h, input, encoding: "utf8",
    env: hermeticEnv({ SPOR_HOME: h, XDG_CONFIG_HOME: h, SPOR_MODE: "local" }),
  });
// A managed document with at least one generation part.
function published(h, id = "art-doc") {
  const r = documentShell.putDocument(nodes(h), { node: source(id), journalDir: path.join(h, "journal", "documents") });
  assert.strictEqual(r.status, "created", JSON.stringify(r));
  assert.ok(r.parts.length >= 1);
  return r;
}
const putNode = (h, raw, rev) => cli(h, ["put-node", "-", "--if-exists", "update", "--revision", rev], raw);
const unchanged = (h, id, before, r) => {
  assert.strictEqual(r.status, 1, r.stdout);
  assert.strictEqual(read(h, id), before, `${id} is untouched`);
};

// ---------- the kernel guard ----------

test("guard: ordinary nodes pass through unchanged", () => {
  const raw = "---\nid: art-x\ntype: artifact\n---\n\nbody\n";
  assert.deepStrictEqual(content.managedDocumentWriteGuard({ id: "art-x", raw }), { ok: true, raw });
  const next = raw.replace("body", "other");
  assert.deepStrictEqual(content.managedDocumentWriteGuard({ id: "art-x", priorRaw: raw, raw: next }), { ok: true, raw: next });
});

// ---------- put-node ----------

test("put-node: a managed root's body is refused, pointing at put-document; metadata edits pass", () => {
  const h = home();
  published(h);
  const before = read(h, "art-doc");
  const r = putNode(h, before.replace("Paragraph 1 ", "Paragraph 1 (edited) "), revision(h, "art-doc"));
  unchanged(h, "art-doc", before, r);
  assert.match(r.stderr, /'art-doc' is a managed document; its body changes only through put-document/);
  assert.match(r.stderr, /spor put-document/);
  // CRLF round-trip of the same body is not a body change
  const crlf = before.replace("title: Doc art-doc", "title: Renamed").replace(/\n/g, "\r\n");
  const ok = putNode(h, crlf, revision(h, "art-doc"));
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(read(h, "art-doc"), /title: Renamed/);
  assert.ok(documentShell.getDocument(nodes(h), { id: "art-doc" }).document.complete, "the document still reads whole");
});

test("put-node: a managed root's continuation_of cannot change", () => {
  const h = home();
  published(h);
  const before = read(h, "art-doc");
  const r = putNode(h, before.replace("status: active", "status: active\ncontinuation_of: art-other"), revision(h, "art-doc"));
  unchanged(h, "art-doc", before, r);
  assert.match(r.stderr, /managed document root; its continuation_of cannot change/);
});

test("put-node: doc_* stamps cannot be forged on create, changed on update, or dropped by omission", () => {
  const h = home();
  published(h);
  const forged = cli(h, ["put-node", "-", "--if-exists", "error"],
    "---\nid: art-forged\ntype: artifact\ntitle: T\nsummary: s\ndate: 2026-10-09\ndoc_sha256: " + "a".repeat(64) + "\n---\n\nbody\n");
  assert.strictEqual(forged.status, 1);
  assert.match(forged.stderr, /may not be created with reserved field 'doc_sha256'/);
  assert.ok(!fs.existsSync(file(h, "art-forged")));

  const before = read(h, "art-doc");
  const changed = putNode(h, before.replace(/doc_bytes: \d+/, "doc_bytes: 1"), revision(h, "art-doc"));
  unchanged(h, "art-doc", before, changed);
  assert.match(changed.stderr, /reserved field 'doc_bytes' cannot change/);

  // Omission is never erasure: the stored stamps are carried forward.
  const omitted = before.replace(/doc_sha256: .*\n/, "").replace(/doc_bytes: .*\n/, "").replace("title: Doc art-doc", "title: Kept");
  const r = putNode(h, omitted, revision(h, "art-doc"));
  assert.strictEqual(r.status, 0, r.stderr);
  const after = graphLib.parseFrontmatter(read(h, "art-doc"), "art-doc.md");
  const was = graphLib.parseFrontmatter(before, "art-doc.md");
  assert.deepStrictEqual([after.title, after.doc_sha256, String(after.doc_bytes)], ["Kept", was.doc_sha256, String(was.doc_bytes)]);
  assert.ok(documentShell.getDocument(nodes(h), { id: "art-doc" }).document.complete);
});

test("put-node: a generation part's body, continuation_of and derived-from links are immutable; other metadata passes", () => {
  const h = home();
  const pub = published(h);
  const part = pub.parts[0];
  const before = read(h, part);
  const body = putNode(h, before.replace("Paragraph", "PARAGRAPH"), revision(h, part));
  unchanged(h, part, before, body);
  assert.match(body.stderr, new RegExp(`'${part}' is an immutable generation part of 'art-doc'; its body cannot change`));

  const host = putNode(h, before.replace("continuation_of: art-doc", "continuation_of: art-elsewhere"), revision(h, part));
  unchanged(h, part, before, host);
  assert.match(host.stderr, /its continuation_of cannot change/);

  const gen = putNode(h, before.replace(/doc_generation: \w+/, `doc_generation: ${"0".repeat(64)}`), revision(h, part));
  unchanged(h, part, before, gen);
  assert.match(gen.stderr, /reserved field 'doc_generation' cannot change/);

  const link = graphLib.parseFrontmatter(before, `${part}.md`).edges.find((e) => e.type === "derived-from");
  assert.ok(link, "a part links back to the document it is cut from");
  const dropped = putNode(h, before.split("\n").filter((l) => !/derived-from/.test(l)).join("\n"), revision(h, part));
  unchanged(h, part, before, dropped);
  assert.match(dropped.stderr, /its derived-from link to '.+' cannot be removed/);

  const meta = putNode(h, before.replace(/^title: .*$/m, "title: Retitled part"), revision(h, part));
  assert.strictEqual(meta.status, 0, meta.stderr);
  assert.ok(documentShell.getDocument(nodes(h), { id: "art-doc" }).document.complete);
});

test("put-node batch: the guards hold for --dir writes too", () => {
  const h = home();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-docguard-batch-"));
  fs.writeFileSync(path.join(dir, "a.md"), "---\nid: art-forged\ntype: artifact\ntitle: T\nsummary: s\ndate: 2026-10-09\ndoc_generation: " + "b".repeat(64) + "\n---\n\nbody\n");
  const r = cli(h, ["put-node", "--dir", dir, "--if-exists", "skip"]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout + r.stderr, /reserved field 'doc_generation'/);
  assert.ok(!fs.existsSync(file(h, "art-forged")));
});

// ---------- patch ----------

test("patch: doc_* stamps and continuation_of are not patchable", () => {
  const h = home();
  const pub = published(h);
  for (const [id, key, door] of [
    ["art-doc", "doc_sha256", /use spor put-document/],
    ["art-doc", "doc_bytes", /use spor put-document/],
    [pub.parts[0], "doc_generation", /use spor put-document/],
    [pub.parts[0], "continuation_of", /structural or server-stamped/],
  ]) {
    const before = read(h, id);
    const r = cli(h, ["patch", id, `${key}=x`]);
    unchanged(h, id, before, r);
    assert.match(r.stderr, new RegExp(`field '${key}' has a dedicated door`));
    assert.match(r.stderr, door);
    const u = cli(h, ["patch", id, "--unset", key]);
    unchanged(h, id, before, u);
  }
  const ok = cli(h, ["patch", "art-doc", "summary=Still fine"]);
  assert.strictEqual(ok.status, 0, ok.stderr);
});

// ---------- edge ----------

test("edge: removing a generation part's derived-from link is refused; other edge edits pass", () => {
  const h = home();
  const pub = published(h);
  const part = pub.parts[0];
  const link = graphLib.parseFrontmatter(read(h, part), `${part}.md`).edges.find((e) => e.type === "derived-from");
  const before = read(h, part);
  const r = cli(h, ["edge", part, "derived-from", link.to, "--remove"]);
  unchanged(h, part, before, r);
  assert.match(r.stderr, /immutable generation part of 'art-doc'; its derived-from link to/);
  fs.writeFileSync(file(h, "art-note"), "---\nid: art-note\ntype: artifact\ntitle: N\nsummary: s\ndate: 2026-10-09\n---\n\nnote\n");
  const add = cli(h, ["edge", part, "relates-to", "art-note"]);
  assert.strictEqual(add.status, 0, add.stderr);
  const rm = cli(h, ["edge", part, "relates-to", "art-note", "--remove"]);
  assert.strictEqual(rm.status, 0, rm.stderr);
  assert.strictEqual(read(h, part), before);
});

// ---------- the lint ----------

test("validate: the near-cap advice is silent on generation pieces, still spoken for ordinary nodes", () => {
  const h = home();
  published(h, "art-doc");
  const big = "x".repeat(7800);
  fs.writeFileSync(file(h, "art-plain"), `---\nid: art-plain\ntype: artifact\ntitle: P\nsummary: s\ndate: 2026-10-09\n---\n\n${big}\n`);
  const v = graphLib.validateGraph(nodes(h), { nearBodyCap: true });
  const near = (v.warnings || []).filter((w) => /approaching the server's/.test(w));
  assert.deepStrictEqual(near.map((w) => w.split(":")[0]), ["art-plain.md"]);
});
