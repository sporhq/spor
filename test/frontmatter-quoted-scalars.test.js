"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseFrontmatter } = require("../lib/kernel/frontmatter.js");

const parse = (title, summary) =>
  parseFrontmatter(`---\nid: issue-x\ntype: issue\ntitle: ${title}\nsummary: ${summary}\n---\nbody\n`, "x.md");

test("double-quoted scalars round-trip JSON.stringify output", () => {
  for (const t of ['He said "hi"', "back\\slash", "dash — é", "tab\tnew\nline", "C:\\dir\\new", "a/b"]) {
    const n = parse(JSON.stringify(t), JSON.stringify(t));
    assert.strictEqual(n.title, t);
    assert.strictEqual(n.summary, t);
  }
});

test("explicit YAML escapes: \\uXXXX, \\xXX, unknown escapes stay literal", () => {
  const n = parse('"a\\u2014b"', '"\\x41 \\q"');
  assert.strictEqual(n.title, "a—b");
  assert.strictEqual(n.summary, "A \\q");
});

test("single-quoted scalars fold only ''", () => {
  const n = parse("'it''s \\n'", "'plain'");
  assert.strictEqual(n.title, "it's \\n");
  assert.strictEqual(n.summary, "plain");
});

test("unwrapped and lone-quote values keep the legacy read", () => {
  const n = parse('say "hi" now', '"lone');
  assert.strictEqual(n.title, 'say "hi" now');
  assert.strictEqual(n.summary, "lone");
});

test("serializeNode quotes values the scalar read would not return verbatim", () => {
  const { serializeNode } = require("../lib/kernel/frontmatter.js");
  for (const t of ['"x"', "'y'", "C:\\new\\temp", 'say "hi"', "plain"]) {
    const raw = serializeNode({ id: "issue-x", type: "issue", title: t, edges: [], body: "b" });
    assert.strictEqual(parseFrontmatter(raw, "x.md").title, t);
  }
  assert.match(serializeNode({ id: "a", type: "issue", title: "plain" }), /title: plain\n/);
});

// ---- round-trip over every scalar position (one reader/writer pair) ----
const { serializeNode } = require("../lib/kernel/frontmatter.js");

// Deterministic generator (no deps): strings drawn from an alphabet heavy in the
// characters the grammar treats specially.
const ALPHABET = ['"', "'", "\\", " ", "\t", ",", "[", "]", "{", "}", ":", "#", "-", "a", "b", "n", "u", "x", "0", "é", "—", "😀", "/"];
function* values(count = 400) {
  let seed = 0x9e3779b9;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (const fixed of [" x", "x ", "   ", "\"", "'", "''", '""', '"a"', "'a'", "a\\", "\\u00", "\\ud83d", "\\xZ9", "- x"]) yield fixed;
  for (let i = 0; i < count; i++) {
    let s = "";
    for (let n = Math.floor(rnd() * 8); n > 0; n--) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
    yield s;
  }
}

test("serializeNode round-trips every generated value in flat, list-item and edge-attr positions", () => {
  for (const v of values()) {
    const node = { id: "x", type: "task", title: v, tags: [v, "ok"], edges: [{ type: "relates-to", to: "n-1", note: v }] };
    const raw = serializeNode(node);
    const back = parseFrontmatter(raw, "x.md");
    assert.strictEqual(back.title, v, `title ${JSON.stringify(v)}`);
    // an empty/whitespace-only edge attr is dropped by design (v === "" only)
    assert.deepStrictEqual(back.tags, [v, "ok"], `tags ${JSON.stringify(v)}`);
    if (v !== "") assert.strictEqual(back.edges[0].note, v, `attr ${JSON.stringify(v)}`);
    assert.strictEqual(serializeNode({ ...back, file: undefined, pin: undefined, exclude: undefined }), raw, `stable ${JSON.stringify(v)}`);
  }
});

test("a double-quoted scalar folded over continuation lines is unescaped whole", () => {
  const n = parseFrontmatter('---\nid: x\ntype: task\ntitle: "a \\"b\\"\n  c\\td"\nsummary: \'it\'\'s\n  ok\'\n---\n', "x.md");
  assert.strictEqual(n.title, 'a "b" c\td');
  assert.strictEqual(n.summary, "it's ok");
});

test("malformed escapes stay literal in block items and edge attrs, never throw", () => {
  const raw = '---\nid: x\ntype: task\ntags:\n  - "a\\"\n  - "\\u12"\nedges:\n  - type: relates-to\n    to: y\n    note: "\\ud83d"\n---\n';
  const n = parseFrontmatter(raw, "x.md");
  assert.deepStrictEqual(n.tags, ['a\\', "\\u12"]);
  assert.strictEqual(n.edges[0].note, String.fromCharCode(0xd83d));
});

test("legacy reads are unchanged: trailing space trimmed in items/edge attrs, a closed quote then a continuation", () => {
  const n = parseFrontmatter('---\nid: x\ntype: task\ntitle: "Foo"\n  bar\ntags:\n  - x  \nedges:\n  - type: blocks  \n    to: b  \n---\n', "x.md");
  assert.strictEqual(n.title, "Foo bar");
  assert.deepStrictEqual(n.tags, ["x"]);
  assert.deepStrictEqual(n.edges, [{ type: "blocks", to: "b" }]);
});
