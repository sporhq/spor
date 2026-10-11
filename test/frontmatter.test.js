// frontmatter.test.js — the ONE node-file grammar (lib/kernel/frontmatter.js,
// task-spor-client-single-frontmatter-parser): the lexer's line ranges, the
// strict/lenient reads, the serializer's round-trip law, and the structure-
// aware editors every local rewrite goes through. The conformance `grammar`
// corpus pins the same surface byte-for-byte; these are the focused claims.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const fm = require("../lib/kernel/frontmatter.js");
const graph = require("../lib/kernel/graph.js");

const doc = (frontmatter, body = "Body.") => `---\n${frontmatter}\n---\n\n${body}\n`;

test("graph.parseFrontmatter IS the kernel grammar's parseFrontmatter (one parser)", () => {
  assert.equal(graph.parseFrontmatter, fm.parseFrontmatter);
});

test("splitDocument/joinDocument: the fence read once, CRLF style remembered and restored", () => {
  const lf = doc("id: a\ntype: task");
  assert.deepEqual(fm.splitDocument(lf), { frontmatter: "id: a\ntype: task", body: "\nBody.\n", crlf: false, fenceEol: "\n", bodyRaw: "\nBody.\n" });
  const crlf = lf.replace(/\n/g, "\r\n");
  const d = fm.splitDocument(crlf);
  assert.equal(d.crlf, true);
  assert.equal(fm.joinDocument(d), crlf);
  // mixed: CRLF frontmatter + LF body keeps each segment's own endings
  const mixed = crlf.split("\r\n").slice(0, 4).join("\r\n") + "\r\n" + "\nBody line\nmore\n";
  const md = fm.splitDocument(mixed);
  assert.equal(md.crlf, true);
  assert.equal(fm.joinDocument(md), mixed);
  // edge shapes the fence/body split must round-trip byte-for-byte
  for (const raw of ["---\r\nid: x\r\n---\nbody\nline\n", "---\r\nid: x\r\n---\n", "---\nid: x\n---\r\nbody\r\n",
    "---\nid: x\n---\nbody\r\nmixed\nx", "---\r\nid: x\r\n---"]) {
    assert.equal(fm.joinDocument(fm.splitDocument(raw)), raw, JSON.stringify(raw));
  }
  assert.equal(fm.withStamp("---\r\nid: x\r\n---\nbody\nline\n", ["s"], ["s: 1"]), "---\r\nid: x\r\ns: 1\r\n---\nbody\nline\n");
  assert.equal(fm.splitDocument("no fence\n---\nid: x\n---\n"), null);
});

test("lexFrontmatter: entries carry the line ranges the editors splice by", () => {
  const text = [
    "id: a",
    "summary: folds",
    "  over two",
    "  lines",
    "commits:",
    "  - r@1",
    "- r@2",
    "edges:",
    "  # comment",
    "  - {type: blocks, to: b}",
    "  - type: relates-to",
    "    to: c",
    "date: 2026-09-27",
  ].join("\n");
  const lex = fm.lexFrontmatter(text, "a.md");
  assert.deepEqual(lex.entries.map((e) => [e.kind, e.key, e.start, e.end]), [
    ["scalar", "id", 0, 1],
    ["scalar", "summary", 1, 4],
    ["list", "commits", 4, 7],
    ["edges", "edges", 7, 12],
    ["scalar", "date", 12, 13],
  ]);
  assert.deepEqual(lex.edges.map((e) => [e.form, e.start, e.end, e.edge]), [
    ["flow", 9, 10, { type: "blocks", to: "b" }],
    ["block", 10, 12, { type: "relates-to", to: "c" }],
  ]);
  assert.deepEqual(lex.fields, { id: "a", summary: "folds over two lines", commits: ["r@1", "r@2"], date: "2026-09-27" });
  assert.deepEqual(lex.faults, []);
});

test("strict read throws the first edge fault (tagged sporParse); lenient read records every fault and keeps the rest", () => {
  const raw = doc("id: a\ntype: task\nedges:\n  - type: relates-to\n  garbage\n  - {type: blocks, to: b}");
  assert.throws(() => fm.parseFrontmatter(raw, "a.md"), (e) => e.sporParse === true && /unparseable edge entry "garbage" in a\.md/.test(e.message));
  const r = fm.readNode(raw, "a.md");
  assert.deepEqual(r.faults, ['unparseable edge entry "garbage"', 'unparseable edge entry {"type":"relates-to"}']);
  assert.deepEqual(r.node.edges, [{ type: "blocks", to: "b" }]);
  assert.equal(r.node.id, "a");
  assert.equal(fm.readNode("no fence", "x.md"), null);
});

test("serializeNode: canonical form, and parse(serialize(parse(x))) is parse(x) (the round-trip law)", () => {
  const raw = doc([
    "id: a",
    "type: task",
    "title: \"Quoted\"",
    "summary: folds",
    "  here",
    "tags:",
    "  - x",
    "  - y",
    "pin: []",
    "edges:",
    "  - to: b",
    "    type: blocks",
    "  - {type: assigned, to: agent-1, profile: p}",
    "repo: r",
  ].join("\n"), "The body.\n\nTwo paragraphs.");
  const n = fm.parseFrontmatter(raw, "a.md");
  const s = fm.serializeNode(n);
  assert.equal(s, [
    "---",
    "id: a",
    "type: task",
    "title: Quoted",
    "summary: folds here",
    "tags: [x, y]",
    "repo: r",
    "project: r",
    "edges:",
    "  - {type: blocks, to: b}",
    "  - {type: assigned, to: agent-1, profile: p}",
    "---",
    "",
    "The body.",
    "",
    "Two paragraphs.",
    "",
  ].join("\n"));
  const back = fm.parseFrontmatter(s, "a.md");
  assert.deepEqual({ ...back, edges: back.edges.map((e) => ({ type: e.type, to: e.to, ...e })) },
    { ...n, edges: n.edges.map((e) => ({ type: e.type, to: e.to, ...e })) });
});

test("serializeNode: a list item the inline form cannot carry falls back to block form; an edge with a non-token value to block form", () => {
  const s = fm.serializeNode({ id: "a", type: "task", commits: ["r@1", "has, comma"], edges: [{ type: "blocks", to: "b", note: "two words" }], body: "" });
  assert.equal(s, "---\nid: a\ntype: task\ncommits:\n  - r@1\n  - has, comma\nedges:\n  - type: blocks\n    to: b\n    note: two words\n---\n");
  const n = fm.parseFrontmatter(s, "a.md");
  assert.deepEqual(n.commits, ["r@1", "has, comma"]);
  assert.deepEqual(n.edges, [{ type: "blocks", to: "b", note: "two words" }]);
});

test("sameEdge compares canonical type through renames and exact target", () => {
  const renames = { "related-to": "relates-to" };
  assert.equal(fm.sameEdge({ type: "related-to", to: "x" }, { type: "relates-to", to: "x" }, renames), true);
  assert.equal(fm.sameEdge({ type: "related-to", to: "x" }, { type: "relates-to", to: "x" }), false);
  assert.equal(fm.sameEdge({ type: "blocks", to: "x" }, { type: "blocks", to: "x-2" }), false);
});

test("withoutEdge removes a block-form entry in FULL (every line) and a flow entry without eating a longer id", () => {
  const raw = doc("id: a\ntype: task\nedges:\n  - type: blocks\n    to: b\n    profile: p\n  - {type: mentions, to: agent-x-2}\n  - {type: mentions, to: agent-x}\ndate: d");
  assert.equal(fm.withoutEdge(raw, { type: "blocks", to: "b" }),
    doc("id: a\ntype: task\nedges:\n  - {type: mentions, to: agent-x-2}\n  - {type: mentions, to: agent-x}\ndate: d"));
  assert.equal(fm.withoutEdge(raw, { type: "mentions", to: "agent-x" }),
    doc("id: a\ntype: task\nedges:\n  - type: blocks\n    to: b\n    profile: p\n  - {type: mentions, to: agent-x-2}\ndate: d"));
  assert.equal(fm.withoutEdge(raw, { type: "blocks", to: "nobody" }), null, "no match -> null, never 'removed'");
  assert.equal(fm.withoutEdge(raw, (e) => e.profile === "p"), doc("id: a\ntype: task\nedges:\n  - {type: mentions, to: agent-x-2}\n  - {type: mentions, to: agent-x}\ndate: d"), "a predicate selects by any parsed attribute");
  assert.equal(fm.withoutEdge("no fence", { type: "x", to: "y" }), null);
});

test("withoutEdge matches an alias spelling through renames (comparison-time only, the file's spelling is never rewritten)", () => {
  const raw = doc("id: a\ntype: task\nedges:\n  - {type: related-to, to: b}\n  - {type: supercedes, to: c}");
  const renames = { "related-to": "relates-to", supercedes: "supersedes" };
  assert.equal(fm.withoutEdge(raw, { type: "relates-to", to: "b" }, renames), doc("id: a\ntype: task\nedges:\n  - {type: supercedes, to: c}"));
  assert.equal(fm.withoutEdge(raw, { type: "relates-to", to: "b" }), null, "without the table it is a raw spelling match");
});

test("withEdge appends after the last edge entry of either form, creates the block when absent, sorts attrs and drops blanks", () => {
  assert.equal(fm.withEdge(doc("id: a\ntype: task"), "blocks", "b", null), doc("id: a\ntype: task\nedges:\n  - {type: blocks, to: b}"));
  assert.equal(fm.withEdge(doc("id: a\nedges:\n  - {type: blocks, to: b}\ndate: d"), "mentions", "c", { z: "1", a: "2", empty: "" }),
    doc("id: a\nedges:\n  - {type: blocks, to: b}\n  - {type: mentions, to: c, a: 2, z: 1}\ndate: d"));
  assert.equal(fm.withEdge(doc("id: a\nedges:\n  - type: blocks\n    to: b\ndate: d"), "mentions", "c", null),
    doc("id: a\nedges:\n  - type: blocks\n    to: b\n  - {type: mentions, to: c}\ndate: d"), "after a block entry's LAST line, never inside it");
  assert.equal(fm.withEdge(doc("id: a\nedges:\ndate: d"), "mentions", "c", null), doc("id: a\nedges:\n  - {type: mentions, to: c}\ndate: d"));
});

test("withStamp strips a key family by parsed entry (continuations included), trims blank ends, appends the stamps, keeps CRLF", () => {
  const raw = doc("id: a\npriority: p2\npriority_by: Someone\n  <s@x>\nstatus: open\npriority_at: t\n");
  assert.equal(fm.withStamp(raw, ["priority", "priority_by", "priority_at", "priority_via"], ["priority: p1", "priority_via: cli"]),
    doc("id: a\nstatus: open\npriority: p1\npriority_via: cli"));
  assert.equal(fm.withStamp(raw, ["priority", "priority_by", "priority_at"], []), doc("id: a\nstatus: open"), "no stamps = clear");
  const crlf = doc("id: a\nstatus: open").replace(/\n/g, "\r\n");
  assert.equal(fm.withStamp(crlf, ["status"], ["status: done"]), doc("id: a\nstatus: done").replace(/\n/g, "\r\n"));
  assert.equal(fm.withStamp("no fence", ["status"], ["status: done"]), null);
});

test("withKey: in place when present, before edges: when absent, appended otherwise; null removes", () => {
  assert.equal(fm.withKey(doc("id: a\nstatus: open\nedges:\n  - {type: blocks, to: b}"), "status", "done"), doc("id: a\nstatus: done\nedges:\n  - {type: blocks, to: b}"));
  assert.equal(fm.withKey(doc("id: a\nedges:\n  - {type: blocks, to: b}"), "execution", "e-1"), doc("id: a\nexecution: e-1\nedges:\n  - {type: blocks, to: b}"));
  assert.equal(fm.withKey(doc("id: a"), "execution", "e-1"), doc("id: a\nexecution: e-1"));
  assert.equal(fm.withKey(doc("id: a\nexecution: e-1\n  folded\nstatus: open"), "execution", null), doc("id: a\nstatus: open"), "removal takes the whole entry");
  assert.equal(fm.withKey(doc("id: a"), "execution", null), doc("id: a"));
});

test("withKeyAfter places the key after the anchor entry's LAST line (a block-form anchor is not split)", () => {
  const raw = doc("id: r\ntype: repo\nslugs:\n  - a\n  - b\ntags: [old]\ndate: d");
  assert.equal(fm.withKeyAfter(raw, "tags", "tags: [x, y]", ["fingerprints", "slugs"]), doc("id: r\ntype: repo\nslugs:\n  - a\n  - b\ntags: [x, y]\ndate: d"));
  assert.equal(fm.withKeyAfter(raw, "tags", null, ["slugs"]), doc("id: r\ntype: repo\nslugs:\n  - a\n  - b\ndate: d"));
  assert.equal(fm.withKeyAfter(doc("id: r\ntags: [old]"), "tags", "tags: [n]", ["slugs"]), doc("id: r\ntags: [n]"), "no anchor -> appended");
});

test("the lint reads list shapes off the parsed node: a block-form tags list on a repo node is a list, and a body line is not frontmatter", () => {
  const files = {
    "repo-x.md": doc("id: repo-x\ntype: repo\ntitle: T\nsummary: S\ndate: d\ntags:\n  - a\n  - b"),
    "dec-y.md": doc("id: dec-y\ntype: decision\ntitle: T\nsummary: S\ndate: d", "tags: mentioned in the body only"),
  };
  const r = graph.validateGraphFiles(files, []);
  assert.deepEqual(r.warnings.filter((w) => /tags/.test(w)), []);
  assert.deepEqual(r.nodes["repo-x"].tags, ["a", "b"]);
});

// issue-spor-frontmatter-inline-edges-silently-dropped: a populated inline
// `edges: [...]` value was ignored by both reads, so a node written that way
// (put_node, REST, capture, merge — models emit flow-style JSON) lost its edges
// with no refusal. It is now read, or refused; never dropped.
test("inline edges: a JSON array, a YAML flow sequence and a multi-line flow list all read as edges, in both reads", () => {
  const cases = [
    ['edges: [{"type":"blocks","to":"task-x"},{"type": "relates-to", "to": "dec-y", "profile": "p-1"}]',
      [{ type: "blocks", to: "task-x" }, { type: "relates-to", to: "dec-y", profile: "p-1" }]],
    ["edges: [{type: blocks, to: task-x}, {type: 'relates-to', target: \"dec-y\", note: \"a, b\"}]",
      [{ type: "blocks", to: "task-x" }, { type: "relates-to", to: "dec-y", note: "a, b" }]],
    ["edges: [\n  {type: blocks, to: task-x},\n  {type: relates-to, to: dec-y},\n]",
      [{ type: "blocks", to: "task-x" }, { type: "relates-to", to: "dec-y" }]],
    ["edges: []", []],
    ["edges: ~", []],
    ["edges: # none yet", []], // a YAML comment is an empty value, not a fault
    ["edges: [{type: blocks, to: task-x}] # trailing", [{ type: "blocks", to: "task-x" }]],
    ["edges: [ # list\n  {type: blocks, to: task-x}, # one\n  {type: mentions, to: \"y #2\"}\n]",
      [{ type: "blocks", to: "task-x" }, { type: "mentions", to: "y #2" }]],
    // an apostrophe inside an unquoted value is a literal, not an opening quote
    ["edges: [{type: blocks, to: task-x, note: don't}]", [{ type: "blocks", to: "task-x", note: "don't" }]],
    // and YAML's '' escape inside a single-quoted scalar does not close it
    ["edges: [{type: blocks, to: task-x, note: 'it''s, # x'}]", [{ type: "blocks", to: "task-x", note: "it's, # x" }]],
  ];
  for (const [line, want] of cases) {
    const raw = doc(`id: a\ntype: task\n${line}\nstatus: open`);
    const node = fm.parseFrontmatter(raw, "a.md");
    assert.deepEqual(node.edges, want, line);
    assert.equal(node.status, "open", line); // the keys after the list still read
    const lenient = fm.readNode(raw, "a.md");
    assert.deepEqual(lenient.faults, [], line);
    assert.deepEqual(lenient.node.edges, want, line);
  }
  // an inline header and block lines under it accumulate, as two headers do
  const mixed = fm.parseFrontmatter(doc('id: a\nedges: [{"type":"blocks","to":"x"}]\n  - {type: mentions, to: y}'), "a.md");
  assert.deepEqual(mixed.edges, [{ type: "blocks", to: "x" }, { type: "mentions", to: "y" }]);
  // the lex range of an inline edge is its whole header
  const lex = fm.lexFrontmatter("id: a\nedges: [\n  {type: blocks, to: x}\n]\nstatus: open");
  assert.deepEqual(lex.edges.map((e) => [e.form, e.start, e.end]), [["inline", 1, 4]]);
  assert.deepEqual(lex.entries.find((e) => e.kind === "edges").inline, { start: 1, end: 4 });
});

test("inline edges: a populated value that is not an edge list is a parse fault (strict throws, lenient records), never a silent drop", () => {
  // (an attribute key the block form cannot re-emit is refused too: accepting
  // it would make the node unloadable after its first edge edit)
  for (const line of ["edges: [{type: blocks}]", "edges: foo", 'edges: {"outbound": [{"type":"blocks","to":"x"}]}',
    "edges: [{type: blocks, to: {nested: 1}}]", 'edges: [{"type":"blocks","to":"x","my attr":"z"}]',
    "edges: [{type: blocks, to: x, -lead: z}]", '[{"type":"blocks","to":"x"}, 3]'.replace(/^/, "edges: "), "edges: [{type: blocks, to: x}"]) {
    const raw = doc(`id: a\ntype: task\n${line}\nstatus: open`);
    assert.throws(() => fm.parseFrontmatter(raw, "a.md"),
      (e) => e.sporParse === true && /^unparseable inline edges list .* in a\.md$/.test(e.message), line);
    const r = fm.readNode(raw, "a.md");
    assert.equal(r.faults.length, 1, line);
    assert.match(r.faults[0], /^unparseable inline edges list /);
    assert.deepEqual(r.node.edges, [], line);
    assert.equal(r.node.status, "open", line); // an unclosed list does not swallow the lint's later keys
  }
});

test("inline edges: a refused multi-line value's inner lines never leak as edges in the lenient read (issue-spor-frontmatter-lenient-inline-edges-leak)", () => {
  const cases = [
    // closed but malformed: the whole gathered range is skipped
    ["edges: [\n  - {type: blocks, to: x},\n  {type: relates-to}\n]\nstatus: open", { start: 2, end: 6 }],
    ["edges: [{type: relates-to},\n- {type: blocks, to: x}]\nstatus: open", { start: 2, end: 4 }],
    // closed, with a key-shaped line inside: still skipped whole
    ["edges: [\nfoo: bar\n- {type: blocks, to: x}\n]\nstatus: open", { start: 2, end: 6 }],
    // never closes: skipped up to the next top-level key, which still reads
    ["edges: [\n  - {type: blocks, to: x}\n  {type: relates-to, to: y}\nstatus: open", { start: 2, end: 5 }],
    ["edges: [\n  - {type: blocks, to: x}\ntags: [a]\nstatus: open", { start: 2, end: 4 }],
  ];
  for (const [body, range] of cases) {
    const fmText = `id: a\ntype: task\n${body}`;
    const raw = doc(fmText);
    assert.throws(() => fm.parseFrontmatter(raw, "a.md"),
      (e) => e.sporParse === true && /^unparseable inline edges list /.test(e.message), body);
    const r = fm.readNode(raw, "a.md");
    assert.equal(r.faults.length, 1, body);
    assert.match(r.faults[0], /^unparseable inline edges list /, body);
    assert.deepEqual(r.node.edges, [], body);
    assert.equal(r.node.status, "open", body);
    const lex = fm.lexFrontmatter(fmText, "a.md", { lenient: true });
    const entry = lex.entries.find((e) => e.kind === "edges");
    assert.deepEqual({ start: entry.start, end: entry.end }, range, body);
  }
  // a block line BELOW a closed refused value still accumulates, as before
  const r = fm.readNode(doc("id: a\nedges: [\n  {type: blocks}\n]\n  - {type: mentions, to: z}\nstatus: open"), "a.md");
  assert.deepEqual(r.node.edges, [{ type: "mentions", to: "z" }]);
  assert.equal(r.faults.length, 1);
});

test("inline edges: the edge editors rewrite a readable inline header to block form, then splice by parsed identity", () => {
  const raw = doc('id: a\nedges: [{"type":"blocks","to":"x"},{"type":"relates-to","to":"y","note":"a b"}]\nstatus: open');
  assert.equal(fm.withoutEdge(raw, { type: "blocks", to: "x" }),
    doc("id: a\nedges:\n  - type: relates-to\n    to: y\n    note: a b\nstatus: open"));
  assert.equal(fm.withEdge(raw, "mentions", "z"),
    doc("id: a\nedges:\n  - {type: blocks, to: x}\n  - type: relates-to\n    to: y\n    note: a b\n  - {type: mentions, to: z}\nstatus: open"));
  // an empty inline header becomes a bare one rather than holding a block line under `[]`
  assert.equal(fm.withEdge(doc("id: a\nedges: []"), "blocks", "x"), doc("id: a\nedges:\n  - {type: blocks, to: x}"));
  assert.equal(fm.withoutEdge(raw, { type: "blocks", to: "nope" }), null);
  // a non-edge editor leaves the inline header byte-for-byte
  assert.equal(fm.withKey(raw, "status", "done"), raw.replace("status: open", "status: done"));
  // an unreadable inline value is never rewritten by an edge editor
  const bad = doc("id: a\nedges: [{type: blocks}]");
  assert.equal(fm.withEdge(bad, "mentions", "z"), doc("id: a\nedges: [{type: blocks}]\n  - {type: mentions, to: z}"));
});
