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
