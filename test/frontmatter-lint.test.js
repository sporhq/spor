"use strict";
// The node-file grammar lint (task-spor-client-single-frontmatter-parser).
// Before lib/kernel/frontmatter.js the grammar lived in N copies — the
// loader, the lint's re-parse, edge add/remove, the stamp/status/tags
// rewrites, the completion key setter, the candidate adopter — each with its
// own fence/key/edge regexes, so every shape fix (block-form edges, the
// `target:` alias, CRLF, list corruption, alias spellings) had to be re-landed
// N times and routinely was not. The fix is structural, so the suite enforces
// the structure: the grammar's regexes may be SPELLED in exactly one file.
// Any other published source that matches a frontmatter fence, a `key: value`
// line, a flow-form `{type:` edge or a block-form `- key:` item against raw
// node text fails this file — reach for splitDocument / readNode /
// parseFrontmatter / the with* editors instead.
//
// Source-scanning, deterministic, no I/O beyond reading the tree.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const GRAMMAR = "lib/kernel/frontmatter.js";
// The published tree plus the operator tooling that reads node files.
const SCAN_DIRS = ["lib", "bin", "scripts", "adapters", "skills", "conformance"];

// Each ban is a fragment of regex SOURCE as it would appear in a JS file.
const BANNED = [
  { name: "the frontmatter fence regex", re: /\[\\s\\S\]\*\?\)\\n---/ },
  { name: "the frontmatter fence regex (opening)", re: /\^---\\n\(/ },
  { name: "the frontmatter fence regex (RegExp source)", re: /\^---\\\\n/ },
  { name: "the key: value line regex", re: /\\w\[\\w-\]\*\):\\s\*\(\.\*\)\$/ },
  { name: "the flow-form edge regex", re: /\\\{type:\\s\*/ },
  { name: "the block-form edge/list item regex", re: /-\\s\+\(\\w\[\\w-\]\*\):/ },
  { name: "a per-key line regex built from a template (`^${key}:`)", re: /RegExp\(`\^\$\{[a-zA-Z_.()]+\}:/ },
  { name: "a strip-a-frontmatter-line regex (`(^|\\n)key:`)", re: /\(\^\|\\\\n\)\$\{/ },
];

function jsFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".js")) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

test("the node-file grammar is spelled in exactly one file", () => {
  const offenders = [];
  for (const dir of SCAN_DIRS) {
    for (const file of jsFiles(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (rel === GRAMMAR) continue;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const ban of BANNED) {
          if (ban.re.test(line)) offenders.push(`${rel}:${i + 1}: ${ban.name}\n    ${line.trim()}`);
        }
      });
    }
  }
  assert.deepStrictEqual(offenders, [], `node-file grammar re-derived outside ${GRAMMAR}:\n  ${offenders.join("\n  ")}`);
});

test("the grammar file itself still spells the fence (the lint is not vacuous)", () => {
  const src = fs.readFileSync(path.join(ROOT, GRAMMAR), "utf8");
  assert.ok(BANNED[0].re.test(src), "fence regex expected in the grammar module");
  assert.ok(BANNED[3].re.test(src), "key line regex expected in the grammar module");
  assert.ok(BANNED[4].re.test(src), "flow edge regex expected in the grammar module");
});
