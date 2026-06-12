#!/usr/bin/env node
// scrub-live-graph.js — generate the live-shape conformance corpus: a
// structure-preserving, content-free snapshot of a real graph
// (REFACTOR.md §2 — "shapes, not content; employer-sensitivity discipline
// starts at home"). Run once to (re)generate; the OUTPUT is committed, this
// tool's run is not reproducible by design (random salt).
//
//   node conformance/tools/scrub-live-graph.js <nodesDir> [outDir]
//
// What survives verbatim: node types, statuses, dates, priorities, edge
// types and topology, pin/exclude/queue_mute/commits shapes, schema-node
// fenced blocks (payloads must stay parseable for the registry; they carry
// type vocabulary, not org content — review the output before committing).
// What is anonymized: node ids (typed prefix + counter), project slugs,
// authors/askers/identities, commit repo slugs and shas, every prose word
// (salted-hash tokens, so word-repetition structure — and therefore tf-idf
// behavior — is preserved without the words).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const kernel = require("../../lib/kernel/graph.js");

const [, , NODES_DIR, OUT_DIR = path.join(__dirname, "..", "corpora", "live-shape", "nodes")] = process.argv;
if (!NODES_DIR) {
  console.error("usage: scrub-live-graph.js <nodesDir> [outDir]");
  process.exit(1);
}

const SALT = crypto.randomBytes(16).toString("hex"); // intentionally not kept
const hash = (s) => crypto.createHash("sha256").update(SALT + s).digest("hex");
const word = (w) => "w" + hash(w.toLowerCase()).slice(0, 6);

// Replace every word token, keep whitespace/punctuation skeleton.
const scrubText = (t) => t.replace(/[A-Za-z][A-Za-z0-9_'-]*/g, (w) => word(w));

// Scrub prose but pass fenced blocks through verbatim (schema payloads and
// attached code must stay parseable; only schema nodes keep their fences —
// other nodes' fences are content and get scrubbed like any prose).
// The preserved spans are exactly what lib/kernel/registry.js FENCE_RE
// matches (language-tagged fences), so the registry parses the scrubbed
// node identically to the original, pairing quirks and all.
const FENCE_RE = /```(\w+)\n([\s\S]*?)```/g;
function scrubBody(body, keepFences) {
  if (!keepFences) return scrubText(body);
  let out = "", last = 0, m;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(body)) !== null) {
    out += scrubText(body.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + scrubText(body.slice(last));
}

// ---- pass 1: parse everything, build the id/project/identity maps ----

const files = {};
for (const f of fs.readdirSync(NODES_DIR).filter((f) => f.endsWith(".md")).sort()) {
  files[f] = fs.readFileSync(path.join(NODES_DIR, f), "utf8");
}

const parsed = [];
for (const [f, raw] of Object.entries(files)) {
  try { parsed.push(kernel.parseFrontmatter(raw, f)); }
  catch { console.error(`skip (no frontmatter): ${f}`); }
}

const idMap = new Map();
const counters = {};
for (const n of parsed) {
  if (!n.id || idMap.has(n.id)) continue;
  const prefix = (n.id.match(/^[a-z]+/) || ["n"])[0];
  counters[prefix] = (counters[prefix] ?? 0) + 1;
  idMap.set(n.id, `${prefix}-n${String(counters[prefix]).padStart(3, "0")}`);
}
const mapId = (id) => idMap.get(id) ?? `gone-${hash(id).slice(0, 6)}`; // dangling stays dangling, consistently

const projMap = new Map();
const mapProj = (p) => {
  if (!projMap.has(p)) projMap.set(p, `p${projMap.size + 1}`);
  return projMap.get(p);
};
const identMap = new Map();
const mapIdent = (v) => {
  if (!identMap.has(v)) identMap.set(v, `person${identMap.size + 1}`);
  return identMap.get(v);
};

// ---- pass 2: re-emit each node with scrubbed fields ----

const LIST_KEYS = new Set(["pin", "exclude", "queue_mute", "commits"]);
const KEEP_VERBATIM = new Set(["type", "status", "date", "version", "compiled_at", "kind", "schema_version", "priority", "authored_via"]);

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const f of fs.readdirSync(OUT_DIR)) fs.unlinkSync(path.join(OUT_DIR, f));

let written = 0;
for (const [f, raw] of Object.entries(files)) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) continue;
  const n = kernel.parseFrontmatter(raw, f);
  if (!n.id) continue;
  const newId = mapId(n.id);
  const isSchema = n.type === "schema";

  const fm = [`id: ${newId}`];
  const seen = new Set(["id", "edges", "body", "file"]);
  const fmKeys = []; // preserve original key order from the frontmatter text
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):/);
    if (kv && !fmKeys.includes(kv[1])) fmKeys.push(kv[1]);
  }
  for (const k of fmKeys) {
    if (seen.has(k) || n[k] === undefined) continue;
    seen.add(k);
    const v = n[k];
    if (KEEP_VERBATIM.has(k)) fm.push(`${k}: ${v}`);
    else if (k === "project") fm.push(`project: ${mapProj(v)}`);
    else if (k === "target") fm.push(`target: ${v === "global" ? "global" : mapId(v)}`);
    else if (k === "author" || k === "asker" || k === "identity") fm.push(`${k}: ${mapIdent(v)}`);
    else if (LIST_KEYS.has(k)) {
      if (!Array.isArray(v) || !v.length) { fm.push(`${k}: []`); continue; }
      const items = v.map((entry) => {
        if (k === "commits") {
          const at = entry.indexOf("@");
          if (at > 0) return `r${mapProj(entry.slice(0, at)).slice(1)}@${hash(entry.slice(at + 1)).slice(0, entry.length - at - 1)}`;
          return hash(entry).slice(0, 8);
        }
        const [target, until] = String(entry).split("@");
        const mapped = idMap.has(target) ? mapId(target) : mapProj(target);
        return until !== undefined ? `${mapped}@${until}` : mapped;
      });
      fm.push(`${k}: [${items.join(", ")}]`);
    } else fm.push(`${k}: ${scrubText(String(v))}`);
  }
  if (n.edges.length) {
    fm.push("edges:");
    for (const e of n.edges) fm.push(`  - {type: ${e.type}, to: ${mapId(e.to)}}`);
  }

  const out = `---\n${fm.join("\n")}\n---\n\n${scrubBody(n.body, isSchema)}\n`;
  fs.writeFileSync(path.join(OUT_DIR, `${newId}.md`), out);
  written++;
}

console.log(`scrubbed ${written} nodes -> ${OUT_DIR}`);
console.log(`projects: ${projMap.size}, identities: ${identMap.size}, id prefixes: ${Object.keys(counters).sort().join(", ")}`);
