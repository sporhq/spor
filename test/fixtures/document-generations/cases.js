// The inputs the document goldens are recorded over (see
// test/helpers/record-document-goldens.js). Pure data; goldens.json holds the
// server's answers. Every MULTI-part case carries a `date:` — the server dates
// an undated document's parts from the real clock, which the recorder cannot
// pin, so an undated multi-part case could only be re-recorded on one day.
const paras = (n, word = "Paragraph", extra = "") =>
  Array.from({ length: n }, (_, i) => `${word} ${i + 1}${extra} — é 😀 \`x\`.`).join("\n\n");
const fm = (lines) => `---\n${lines.join("\n")}\n---\n`;

const generations = [
  { name: "multi-part decision, astral text, edges", today: "2026-10-09",
    source: fm(["id: dec-foo", "type: decision", "repo: spor", "title: Foo [x]", "summary: s", "date: 2026-10-01", "edges:", "  - {type: relates-to, to: dec-bar}"]) + "\n" + paras(1200) + "\n" },
  { name: "fitting body replaces spill stamps", today: "2026-10-09",
    source: fm(["id: art-small", "type: artifact", "title: Small", "summary: s", "spill_sha256: abc", "spill_bytes: 3", "doc_sha256: 00"]) + "short body\n" },
  { name: "CRLF source", today: "2026-10-09",
    source: fm(["id: art-crlf", "type: artifact", "title: C", "summary: s", "date: 2026-10-01"]).replace(/\n/g, "\r\n") + "\r\n" + "line\r\n".repeat(3000) },
  { name: "near-limit id fits a hashed base", today: "2026-10-09",
    source: fm([`id: art-${"a".repeat(195)}`, "type: artifact", "title: L", "summary: s", "date: 2026-10-01"]) + "z".repeat(20000) + "\n" },
  { name: "frontmatter ending in a blank line", today: "2026-10-09",
    source: "---\nid: art-blank\ntype: artifact\ntitle: T\n\n---\nbody\n" },
  { name: "person host, folded summary", today: "2026-10-09",
    source: fm(["id: person-carol", "type: person", "title: Carol", "summary: a long", "  folded summary", "date: 2026-10-02"]) + "\n" + paras(500, "Note") + "\n" },
  { name: "a root carrying a part stamp is refused", today: "2026-10-09",
    source: fm(["id: art-x", "type: artifact", "title: X", "summary: s", "continuation_of: art-y"]) + "body\n" },
];

// Read cases are built FROM a generation, so they are a function of the
// client kernel's output (which the generation goldens pin to the server's).
function reads() {
  const content = require("../../../lib/kernel/content.js");
  const g = content.documentGeneration(generations[0].source, { prefixes: ["dec-"], today: "2026-10-09" });
  const files = (over = {}) => {
    const f = { [g.id]: g.root, ...Object.fromEntries(g.parts.map((p) => [p.id, p.raw])), ...over };
    for (const [k, v] of Object.entries(f)) if (v == null) delete f[k];
    return f;
  };
  const p2 = g.parts[0];
  const legacyRoot = "---\nid: art-leg\ntype: artifact\ntitle: L\nsummary: s\nspill_sha256: " +
    require("node:crypto").createHash("sha256").update("head").digest("hex") + "\nspill_bytes: 4\n---\n\nhead\n_(continues in art-leg-2)_\n";
  const legacyPart = "---\nid: art-leg-2\ntype: artifact\ntitle: L2\nsummary: s\ncontinuation_of: art-leg\nedges:\n  - {type: derived-from, to: art-leg}\n---\n\n_(continued from art-leg)_\ntail\n";
  return [
    { name: "complete generation", root: g.id, files: files() },
    { name: "missing part", root: g.id, files: files({ [g.parts[1].id]: null }) },
    { name: "edited part fails the digest", root: g.id, files: files({ [p2.id]: p2.raw.replace("Paragraph", "PARAGRAPH") }) },
    { name: "re-stamped part is foreign", root: g.id, files: files({ [p2.id]: p2.raw.replace(/doc_generation: \w+/, `doc_generation: ${"0".repeat(64)}`) }) },
    { name: "broken header", root: g.id, files: files({ [p2.id]: p2.raw.replace("_(continued from", "_(continued frum") }) },
    { name: "pinned generation root", root: g.id, files: files(), pinned: g.root },
    { name: "legacy spill, prefix stamp holds", root: "art-leg", files: { "art-leg": legacyRoot, "art-leg-2": legacyPart } },
    { name: "legacy spill, prefix stamp broken", root: "art-leg", files: { "art-leg": legacyRoot.replace("\nhead\n", "\nHEAD\n"), "art-leg-2": legacyPart } },
    { name: "pinned legacy spill is not reproducible", root: "art-leg", files: { "art-leg": legacyRoot, "art-leg-2": legacyPart }, pinned: legacyRoot },
    { name: "ordinary node", root: "art-plain", files: { "art-plain": "---\nid: art-plain\ntype: artifact\ntitle: P\nsummary: s\n---\nplain body\n" } },
  ];
}

module.exports = { generations, reads };
