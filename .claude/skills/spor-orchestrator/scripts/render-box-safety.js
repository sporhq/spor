#!/usr/bin/env node
// render-box-safety.js [--check] — splice partials/box-safety.md's blocks into
// every orchestrator prompt/reference that carries them
// (task-spor-consolidate-box-safety-rules).
//
// Local-operator tooling under .claude/, outside the published package.
// The rules (never run a host-mutating ops script unsandboxed, kill only your
// own processes, run suites foreground-or-detach-and-poll) used to be nine
// hand-copied paragraphs that drifted per incident. dispatch --template only
// substitutes {{vars}}, so there is no runtime include: the single source is
// rendered INTO the files, between
//   <!-- box-safety:begin NAME [indent=N] [cmd=...] -->
//   <!-- box-safety:end -->
// and --check (also run by test/box-safety-partial.test.js) exits 1 on drift.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const SKILLS = path.resolve(__dirname, "..", "..");
const PARTIAL = path.join(SKILLS, "spor-orchestrator", "partials", "box-safety.md");

const BEGIN = /^([ \t]*)<!-- box-safety:begin (\S+)((?: [a-z]+=[^>]*?)*) -->[ \t]*$/;
const END = /^[ \t]*<!-- box-safety:end -->[ \t]*$/;

function readBlocks(text) {
  const blocks = {};
  const re = /<!-- block: (\S+) -->\n([\s\S]*?)\n<!-- \/block -->/g;
  let m;
  while ((m = re.exec(text))) blocks[m[1]] = m[2];
  return blocks;
}

function attrs(s) {
  const out = {};
  for (const m of s.matchAll(/ ([a-z]+)=(.*?)(?= [a-z]+=|$)/g)) out[m[1]] = m[2];
  return out;
}

function render(content, blocks, file) {
  const lines = content.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = BEGIN.exec(lines[i]);
    if (!m) { out.push(lines[i]); continue; }
    const [, lead, name, rest] = m;
    const a = attrs(rest);
    if (!(name in blocks)) throw new Error(`${file}: unknown box-safety block "${name}"`);
    let j = i + 1;
    while (j < lines.length && !END.test(lines[j])) j++;
    if (j >= lines.length) throw new Error(`${file}: box-safety:begin ${name} has no end marker`);
    const pad = " ".repeat(Number(a.indent || 0));
    const body = blocks[name].replace(/<<cmd>>/g, a.cmd || "npm test");
    out.push(lines[i]);
    for (const l of body.split("\n")) out.push(l ? pad + l : l);
    out.push(lines[j]);
    i = j;
  }
  return out.join("\n");
}

function targets() {
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); }
      else if (e.name.endsWith(".md") && p !== PARTIAL && /box-safety:begin/.test(fs.readFileSync(p, "utf8"))) found.push(p);
    }
  };
  for (const s of ["spor-orchestrator", "spor-orchestrator-codex"]) walk(path.join(SKILLS, s));
  return found.sort();
}

function main() {
  const check = process.argv.includes("--check");
  const blocks = readBlocks(fs.readFileSync(PARTIAL, "utf8"));
  let drift = 0;
  for (const f of targets()) {
    const cur = fs.readFileSync(f, "utf8");
    const next = render(cur, blocks, f);
    if (next === cur) continue;
    drift++;
    if (check) console.error(`drift: ${path.relative(SKILLS, f)}`);
    else { fs.writeFileSync(f, next); console.log(`rendered ${path.relative(SKILLS, f)}`); }
  }
  if (check && drift) { console.error("run: node scripts/render-box-safety.js"); process.exit(1); }
}

if (require.main === module) main();
module.exports = { readBlocks, render, targets, PARTIAL };
