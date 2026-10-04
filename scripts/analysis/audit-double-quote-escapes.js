#!/usr/bin/env node
// Audit a nodes dir for frontmatter values whose reading changed when the
// parser began unescaping wholly double-quoted scalars per YAML 1.2
// (art-spor-frontmatter-double-quote-unescape-2026-10-03). Read-only.
//
//   node scripts/analysis/audit-double-quote-escapes.js <nodes-dir> [--json]
//
// Reports, per node, each wholly double-quoted frontmatter scalar containing a
// backslash, classified by how the new read differs from the old literal one:
//   json-style  only \" \\ \/ (the JSON.stringify shape — the new read is the
//               INTENDED one; the old read kept the backslashes)
//   control     \n \t \r \b \f \v \0 \a \e \N \_ \L \P \xXX \uXXXX \UXXXXXXXX
//               (the read now yields a control/other char — a Windows path or
//               regex written in quotes is silently changed)
//   literal     any other \X (unknown escape, kept literal by the parser)
const fs = require("fs");
const path = require("path");
const { splitDocument } = require("../../lib/kernel/frontmatter.js");

const CONTROL = /^(?:[ntrbfv0aeN_LP ]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/;

function classify(inner) {
  const kinds = new Set();
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== "\\") continue;
    const rest = inner.slice(i + 1);
    if (/^["\\/]/.test(rest)) kinds.add("json-style");
    else if (CONTROL.test(rest)) kinds.add("control");
    else kinds.add("literal");
    i++;
  }
  return kinds;
}

// Wholly double-quoted values only — `key: "…"`, `- "…"`, `- attr: "…"` —
// because the parser unescapes a scalar only when the quotes wrap the whole
// value (a `"\n"` inside a plain scalar stays literal). Folded continuations
// are joined onto their key first.
function scalars(frontmatter) {
  const out = [];
  const logical = [];
  for (const line of frontmatter.split(/\r?\n/)) {
    if (/^\s+\S/.test(line) && logical.length && !/^\s*-\s/.test(line)) logical[logical.length - 1] += " " + line.trim();
    else logical.push(line);
  }
  for (const l of logical) {
    const m = /^\s*(?:-\s+)?(?:[\w-]+:\s+)?"((?:[^"\\]|\\.)*)"\s*$/.exec(l);
    if (m && m[1].includes("\\")) out.push({ line: l.slice(0, 160), inner: m[1] });
  }
  return out;
}

function main() {
  const dir = process.argv[2];
  const json = process.argv.includes("--json");
  if (!dir) { console.error("usage: audit-double-quote-escapes.js <nodes-dir> [--json]"); process.exit(2); }
  const hits = [];
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    n++;
    const doc = splitDocument(fs.readFileSync(path.join(dir, f), "utf8"));
    if (!doc) continue;
    for (const s of scalars(doc.frontmatter)) {
      const kinds = [...classify(s.inner)].sort();
      hits.push({ id: f.slice(0, -3), kinds, line: s.line });
    }
  }
  if (json) { console.log(JSON.stringify({ scanned: n, hits }, null, 1)); return; }
  const tally = {};
  for (const h of hits) for (const k of h.kinds) tally[k] = (tally[k] || 0) + 1;
  console.log(`scanned ${n} nodes; ${hits.length} double-quoted scalar(s) with a backslash in ${new Set(hits.map((h) => h.id)).size} node(s); ${JSON.stringify(tally)}`);
  for (const h of hits.filter((h) => h.kinds.some((k) => k !== "json-style"))) console.log(`${h.kinds.join("+")}\t${h.id}\t${h.line}`);
}
main();
