// content.test.js — the graph-native content contracts
// (task-spor-chatgpt-content-contracts): lib/kernel/content.js, the seed
// schema-artifact validate() that mirrors it at the write door, and the
// uses-asset candidate edge schema.
//
// Run: node --test test/content.test.js
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const graph = require(path.join(__dirname, "..", "lib", "graph.js"));
const content = require(path.join(__dirname, "..", "lib", "kernel", "content.js"));
const frontmatter = require(path.join(__dirname, "..", "lib", "kernel", "frontmatter.js"));
const candLib = require(path.join(__dirname, "..", "lib", "candidates.js"));
const { createSandbox } = require(path.join(__dirname, "..", "lib", "sandbox.js"));
const { scale } = require(path.join(__dirname, "helpers", "launch.js"));

const HEX = (c) => c.repeat(64);
const DIGEST = `sha256:${HEX("a")}`;
const REV = "0123456789abcdef0123456789abcdef01234567";

// The seed validate(), through the same sandbox the server runs it in.
const SLACK = { timeoutMs: scale(5000) };
let _sb = null;
function seedValidate(node) {
  if (!_sb) {
    const s = graph.loadSeedSchemas().find((x) => x.key === "artifact");
    _sb = createSandbox(s.codeBlocks.join("\n"), { timeoutMs: scale(100) });
  }
  return _sb.call("validate", [node], SLACK);
}

const descriptor = (over = {}) => ({
  id: "art-shot", type: "artifact", title: "t", summary: "s",
  asset_digest: DIGEST, asset_media_type: "image/png", asset_bytes: "2048", asset_width: "640", asset_height: "480",
  ...over,
});

// One corpus, two implementations: every row must get the SAME errors from
// the kernel and from the seed schema's sandboxed mirror.
const CORPUS = [
  { id: "art-legacy", type: "artifact", title: "t", summary: "s" },
  { id: "art-md", content_format: "markdown" },
  { id: "art-txt", content_format: "text" },
  { id: "art-html", content_format: "html" },
  descriptor(),
  descriptor({ asset_alt: "a login form" }),
  descriptor({ asset_media_type: "image/svg+xml" }),
  descriptor({ asset_digest: HEX("a") }),
  descriptor({ asset_digest: `sha256:${HEX("A")}` }),
  descriptor({ asset_bytes: "0" }),
  descriptor({ asset_width: "01" }),
  descriptor({ asset_height: "1.5" }),
  descriptor({ asset_hash: "x" }),
  descriptor({ asset_alt: "x".repeat(1001) }),
  { id: "art-half", asset_digest: DIGEST },
  { id: "art-alt-only", asset_alt: "orphan alt" },
  { id: "art-root", doc_sha256: HEX("b"), doc_bytes: "12000" },
  { id: "art-root-half", doc_sha256: HEX("b") },
  { id: "art-root-bad", doc_sha256: "abc", doc_bytes: "-1" },
  { id: "art-part", doc_generation: HEX("b"), continuation_of: "art-root" },
  { id: "art-part-orphan", doc_generation: HEX("b") },
  { id: "art-part-root", doc_generation: HEX("b"), continuation_of: "art-root", doc_sha256: HEX("b"), doc_bytes: "1" },
  { id: "art-sel", selection: `spor-source:art-doc@${REV}#utf16=3,9` },
  { id: "art-sel-doc", selection: `spor-source:art-doc@${REV}?doc=${HEX("c")}#utf16=0,1` },
  { id: "art-sel-img", selection: `spor-image:art-shot@${DIGEST}#xywh=0,0,10,10` },
  { id: "art-sel-img-whole", selection: `spor-image:art-shot@${DIGEST}` },
  { id: "art-sel-empty", selection: `spor-source:art-doc@${REV}#utf16=4,4` },
  { id: "art-sel-zero-pad", selection: `spor-source:art-doc@${REV}#utf16=03,9` },
  { id: "art-sel-empty-doc", selection: `spor-source:art-doc@${REV}?doc=#utf16=3,9` },
  { id: "art-sel-shortrev", selection: "spor-source:art-doc@abc123#utf16=3,9" },
  { id: "art-sel-badid", selection: `spor-image:Art_Shot@${DIGEST}` },
  { id: "art-sel-region", selection: `spor-image:art-shot@${DIGEST}#xywh=0,0,0,10` },
  { id: "art-sel-junk", selection: "https://example.com/x" },
];

test("seed schema-artifact validate() and kernel validateContentFields agree on every corpus row", () => {
  for (const row of CORPUS) {
    assert.deepEqual(seedValidate(row), content.validateContentFields(row), `row ${row.id}`);
  }
  // and the corpus actually exercises both verdicts
  const verdicts = CORPUS.map((r) => content.validateContentFields(r).length === 0);
  assert.ok(verdicts.includes(true) && verdicts.includes(false));
});

test("legacy nodes: no content keys means no errors, and the conformance corpora validate clean", () => {
  const root = path.join(__dirname, "..", "conformance", "corpora");
  let n = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) {
        const r = frontmatter.readNode(fs.readFileSync(p, "utf8"), e.name);
        if (!r || !r.node) continue;
        n++;
        assert.deepEqual(content.validateContentFields(r.node), [], p);
        if (r.node.type === "artifact" && !r.node.status) assert.deepEqual(seedValidate(r.node), [], p);
        assert.deepEqual(content.nodeAssetEmbeds(r.node), [], `${p}: a legacy body embeds nothing`);
      }
    }
  };
  walk(root);
  assert.ok(n > 50, `walked ${n} corpus nodes`);
});

test("asset descriptors: all-or-none, typed, and SVG is refused", () => {
  assert.deepEqual(content.validateAssetDescriptor(descriptor()), []);
  assert.deepEqual(content.assetDescriptor(descriptor()), {
    id: "art-shot", digest: DIGEST, media_type: "image/png", bytes: 2048, width: 640, height: 480, alt: null,
  });
  assert.match(content.validateAssetDescriptor({ asset_digest: DIGEST }).join(), /missing asset_media_type, asset_bytes, asset_width, asset_height/);
  assert.match(content.validateAssetDescriptor(descriptor({ asset_media_type: "image/svg+xml" })).join(), /not one of/);
  assert.match(content.validateAssetDescriptor(descriptor({ asset_sha: "x" })).join(), /unknown asset key 'asset_sha'/);
  assert.equal(content.assetDescriptor(descriptor({ asset_bytes: "0" })), null);
  assert.equal(content.assetDescriptor({ id: "art-plain" }), null);
  // JSON numbers read the same as frontmatter strings
  assert.deepEqual(content.validateAssetDescriptor(descriptor({ asset_bytes: 2048, asset_width: 640, asset_height: 480 })), []);
});

test("asset URIs: id plus optional sha256 pin, round-tripping", () => {
  assert.deepEqual(content.parseAssetUri("spor-asset:art-shot"), { ok: true, id: "art-shot", digest: null });
  assert.deepEqual(content.parseAssetUri(`spor-asset:art-shot@${DIGEST}`), { ok: true, id: "art-shot", digest: DIGEST });
  for (const bad of ["spor-asset:", "spor-asset:Art", `spor-asset:art-x@${HEX("a")}`, "spor-asset:art-x@sha256:abc", "asset:art-x"]) {
    assert.equal(content.parseAssetUri(bad).ok, false, bad);
  }
  assert.equal(content.formatAssetUri({ id: "art-shot", digest: DIGEST }), `spor-asset:art-shot@${DIGEST}`);
  assert.throws(() => content.formatAssetUri({ id: "BAD" }));
});

test("embeds: only inline images outside code count — fenced, spanned, commented and escaped URIs are examples", () => {
  const md = [
    "Intro ![shot](spor-asset:art-a) and `![x](spor-asset:art-span)` and ``a ` ![y](spor-asset:art-span2) ``",
    "```md",
    "![fenced](spor-asset:art-fenced)",
    "```",
    "~~~~",
    "~~~",
    "![still fenced](spor-asset:art-tilde)",
    "~~~~",
    "``` not ` a fence",
    "\\![escaped](spor-asset:art-esc) <!-- ![c](spor-asset:art-comment) -->",
    `![pinned](<spor-asset:art-b@${DIGEST}> "title") [a link](spor-asset:art-link) ![web](https://x/y.png)`,
    "![bad](spor-asset:BAD)",
    "````",
    "![unclosed fence runs to the end](spor-asset:art-unclosed)",
  ].join("\n");
  const got = content.extractAssetEmbeds(md);
  assert.deepEqual(got.map((e) => e.id ?? e.error), [
    "art-a", "art-b", "asset URI 'spor-asset:BAD': 'BAD' is not a node id",
  ]);
  // offsets are UTF-16 indices into the text
  assert.equal(md.slice(got[0].start, got[0].end), "![shot](spor-asset:art-a)");
  assert.equal(got[1].digest, DIGEST);
  assert.equal(got[1].alt, "pinned");
  // a CRLF body reads the same
  assert.deepEqual(content.extractAssetEmbeds("```\r\n![f](spor-asset:art-f)\r\n```\r\n![k](spor-asset:art-k)").map((e) => e.id), ["art-k"]);
  // offsets survive astral characters before the embed
  const astral = "😀 ![e](spor-asset:art-e)";
  const [e] = content.extractAssetEmbeds(astral);
  assert.equal(e.start, 3);
  assert.equal(astral.slice(e.start, e.end), "![e](spor-asset:art-e)");
});

test("nodeAssetEmbeds: only a content_format: markdown body embeds anything", () => {
  const body = "\n![a](spor-asset:art-a)\n";
  assert.deepEqual(content.nodeAssetEmbeds({ body }), []);
  assert.deepEqual(content.nodeAssetEmbeds({ content_format: "text", body }), []);
  assert.deepEqual(content.nodeAssetEmbeds({ content_format: "markdown", body }).map((e) => e.id), ["art-a"]);
});

test("reconcileAssetEdges reports missing, extra, malformed, mismatched and unresolved inclusions", () => {
  const node = {
    content_format: "markdown",
    body: `![a](spor-asset:art-a) ![a again](spor-asset:art-a) ![b](spor-asset:art-b@sha256:${HEX("b")}) ![z](spor-asset:art-z) ![x](spor-asset:X)`,
    edges: [{ type: "uses-asset", to: "art-b" }, { type: "uses-asset", to: "art-gone" }, { type: "relates-to", to: "art-a" }],
  };
  const descriptors = { "art-a": descriptor({ id: "art-a" }), "art-b": descriptor({ id: "art-b" }) };
  const r = content.reconcileAssetEdges(node, { resolve: (id) => descriptors[id] || null });
  assert.deepEqual(r.missing, ["art-a", "art-z"]);
  assert.deepEqual(r.extra, ["art-gone"]);
  assert.equal(r.malformed.length, 1);
  assert.deepEqual(r.mismatch, [{ id: "art-b", pinned: `sha256:${HEX("b")}`, current: DIGEST }]);
  assert.deepEqual(r.unresolved, ["art-z"]);
  // a legacy body reconciles to nothing, whatever its edges say about embeds
  assert.deepEqual(content.reconcileAssetEdges({ body: "![a](spor-asset:art-a)", edges: [] }).missing, []);
});

test("document digest is sha256 of the canonical core — the server's documentGeneration formula", () => {
  const body = "\n\nHello 😀 world\n\n  \n";
  const core = content.documentCore(body);
  assert.equal(core, "Hello 😀 world");
  assert.equal(content.documentDigest(core), crypto.createHash("sha256").update("Hello 😀 world", "utf8").digest("hex"));
  assert.equal(content.documentBytes(core), 16);
  assert.equal(core.length, 14, "UTF-16 length differs from the byte length");
  assert.deepEqual(content.validateDocumentStamps({}), []);
});

test("document snapshots: root revision, optional digest pair, ordered generation parts", () => {
  const d = HEX("d");
  const ok = {
    root: "art-doc", revision: REV, doc_sha256: d, doc_bytes: 20000,
    parts: [{ id: `art-doc-g${d.slice(0, 8)}-2`, revision: REV }, { id: `art-doc-g${d.slice(0, 8)}-3`, revision: REV }],
  };
  assert.deepEqual(content.validateDocumentSnapshot(ok), []);
  assert.deepEqual(content.validateDocumentSnapshot({ root: "art-doc", revision: REV, parts: [] }), []);
  // a legacy spill: parts are mutable, named freely, pinned by their own revisions
  assert.deepEqual(content.validateDocumentSnapshot({ root: "art-doc", revision: REV, parts: [{ id: "art-doc-2", revision: REV }] }), []);
  assert.match(content.validateDocumentSnapshot({ ...ok, parts: [ok.parts[1], ok.parts[0]] }).join(), /is not part 2 of generation/);
  assert.match(content.validateDocumentSnapshot({ ...ok, doc_bytes: undefined }).join(), /come together/);
  assert.match(content.validateDocumentSnapshot({ ...ok, revision: "abc" }).join(), /git blob sha/);
  assert.match(content.validateDocumentSnapshot({ ...ok, parts: [{ id: "art-doc", revision: REV }] }).join(), /repeats/);
  assert.match(content.validateDocumentSnapshot({ root: "art-doc", revision: REV }).join(), /parts must be an array/);
});

test("source selections: UTF-16 offsets into the exact document, never splitting a surrogate pair", () => {
  const text = "ab😀cd";
  const doc = content.documentDigest(text);
  const sel = { kind: "source", node: "art-doc", revision: REV, doc_sha256: doc, start: 2, end: 4, quote: "😀" };
  assert.deepEqual(content.validateSelection(sel, { text }), []);
  assert.deepEqual(content.utf8Range(text, 2, 4), { start: 2, end: 6 });
  assert.match(content.validateSelection({ ...sel, start: 3, quote: undefined }, { text }).join(), /surrogate pair/);
  assert.match(content.validateSelection({ ...sel, end: 7 }, { text }).join(), /past the document/);
  assert.match(content.validateSelection({ ...sel, quote: "cd" }, { text }).join(), /quote does not match/);
  assert.match(content.validateSelection(sel, { text: "ab😀ce" }).join(), /does not match the document text/);
  assert.match(content.validateSelection(sel, { doc_sha256: HEX("e") }).join(), /does not match the document/);
  assert.match(content.validateSelection({ ...sel, start: 4 }).join(), /empty or reversed/);
  assert.match(content.validateSelection({ kind: "range" }).join(), /not source or image/);
});

test("image selections: integer pixel regions inside the exact asset", () => {
  const sel = { kind: "image", asset: "art-shot", digest: DIGEST, region: { x: 600, y: 0, w: 40, h: 480 } };
  assert.deepEqual(content.validateSelection(sel, { descriptor: descriptor() }), []);
  assert.match(content.validateSelection({ ...sel, region: { x: 601, y: 0, w: 40, h: 480 } }, { descriptor: descriptor() }).join(), /exceeds the 640x480/);
  assert.match(content.validateSelection({ ...sel, digest: `sha256:${HEX("f")}` }, { descriptor: descriptor() }).join(), /does not match the descriptor/);
  assert.match(content.validateSelection(sel, { descriptor: { id: "art-plain" } }).join(), /not a valid asset descriptor/);
  assert.deepEqual(content.validateSelection({ kind: "image", asset: "art-shot", digest: DIGEST }), []);
});

test("selection URIs: one canonical scalar per selection, round-tripping byte for byte", () => {
  const sels = [
    { kind: "source", node: "art-doc", revision: REV, start: 0, end: 5 },
    { kind: "source", node: "art-doc", revision: HEX("0"), doc_sha256: HEX("c"), start: 10, end: 12 },
    { kind: "image", asset: "art-shot", digest: DIGEST, region: { x: 1, y: 2, w: 3, h: 4 } },
    { kind: "image", asset: "art-shot", digest: DIGEST },
  ];
  for (const s of sels) {
    const uri = content.formatSelection(s);
    const p = content.parseSelection(uri);
    assert.ok(p.ok, `${uri}: ${p.error}`);
    assert.equal(content.formatSelection(p.selection), uri);
    // and it survives a trip through the node-file grammar as a flat scalar
    const raw = `---\nid: task-x\ntype: task\ntitle: t\nsummary: s\nselection: ${uri}\n---\nbody\n`;
    assert.equal(frontmatter.parseFrontmatter(raw, "task-x.md").selection, uri);
  }
  assert.equal(content.formatSelection(sels[0]), `spor-source:art-doc@${REV}#utf16=0,5`);
  assert.equal(content.formatSelection(sels[2]), `spor-image:art-shot@${DIGEST}#xywh=1,2,3,4`);
  assert.match(content.parseSelection(`spor-source:art-doc@${REV}#utf16=00,5`).error, /canonical form|offsets/);
  assert.equal(content.parseSelection("spor-asset:art-shot").ok, false);
  assert.throws(() => content.formatSelection({ kind: "source", node: "art-doc", revision: REV, start: 5, end: 5 }));
});

// ---------- the uses-asset candidate ----------

function tmpGraph(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-content-"));
  const nodesDir = path.join(dir, "nodes");
  fs.mkdirSync(nodesDir, { recursive: true });
  for (const [name, c] of Object.entries(files)) fs.writeFileSync(path.join(nodesDir, name), c);
  return nodesDir;
}

test("uses-asset ships as a candidate: inert until adopted ACTIVE, weight from the registry, resident override wins", () => {
  const cand = candLib.loadCandidates().find((c) => c.id === "schema-edge-uses-asset");
  assert.ok(cand, "the candidate pack carries schema-edge-uses-asset");
  assert.equal(cand.kind, "edge-schema");
  assert.equal(cand.declaredType, "uses-asset");
  assert.ok(!graph.seedRegistry().edgeSchemas.has("uses-asset"), "not in the seed registry");

  const doc = "---\nid: art-doc\ntype: artifact\ntitle: d\nsummary: d\ncontent_format: markdown\nedges:\n  - {type: uses-asset, to: art-shot}\n---\n\n![s](spor-asset:art-shot)\n";
  const shot = `---\nid: art-shot\ntype: artifact\ntitle: s\nsummary: a screenshot\nasset_digest: ${DIGEST}\nasset_media_type: image/png\nasset_bytes: 10\nasset_width: 4\nasset_height: 4\n---\n`;

  // proposed = inert: the registry does not know the type yet
  const proposed = graph.loadGraph(tmpGraph({
    "art-doc.md": doc, "art-shot.md": shot,
    "schema-edge-uses-asset.md": candLib.adoptMarkdown(cand, { status: "proposed", pkgVersion: "0.0.0-test" }),
  }));
  assert.ok(!proposed.registry.edgeSchemas.has("uses-asset"));

  const active = graph.loadGraph(tmpGraph({
    "art-doc.md": doc, "art-shot.md": shot,
    "schema-edge-uses-asset.md": candLib.adoptMarkdown(cand, { status: "active", pkgVersion: "0.0.0-test" }),
  }));
  assert.equal(active.registry.edgeWeight("uses-asset"), 0.3);
  assert.equal(active.registry.edgeSchemas.get("uses-asset").payload.capturable, false);

  // a resident schema with its own weight is authoritative over the packaged one
  const override = candLib.adoptMarkdown(cand, { status: "active", pkgVersion: "0.0.0-test" })
    .replace('"weight": 0.3', '"weight": 0.6');
  const overridden = graph.loadGraph(tmpGraph({ "art-doc.md": doc, "art-shot.md": shot, "schema-edge-uses-asset.md": override }));
  assert.equal(overridden.registry.edgeWeight("uses-asset"), 0.6);
});

test("content.js stays dependency-free: node builtins only", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "kernel", "content.js"), "utf8");
  const reqs = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(reqs, ["crypto"]);
});
