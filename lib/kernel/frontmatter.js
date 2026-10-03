// kernel/frontmatter.js — THE node-file grammar: one parser, one serializer,
// one set of structure-aware editors (task-spor-client-single-frontmatter-
// parser). Pure: strings in, structures/strings out, no I/O, no registry.
//
// Before this module the grammar lived in N copies — parseFrontmatter (the
// loader), validateGraphFiles' lenient re-parse (the lint), appendEdgeLine /
// removeEdgeLine / rewriteStamp / rewriteStatus / rewriteTags (bin/spor.js),
// setFrontmatterKey (lib/shell/completion.js), adoptMarkdown (lib/candidates.js)
// — each re-deriving the fence, the key line, the edge shapes and the list
// shapes with its own regexes, so every fix to one (block-form edges, the
// `target:` alias, CRLF, stray-line list corruption, alias spellings) had to be
// re-landed in the others and routinely was not. Now every one of them
// consumes the SAME lexer: a node file is read into line-ranged ENTRIES
// (which lines a key, a list, an edge entry occupies), reads fold those
// entries into the node object, and edits splice by entry range — so a
// mutation matches by PARSED identity ({type, to}, a key) regardless of the
// YAML style the file happens to use, and touches no other byte.
// test/frontmatter-lint.test.js bans the fence/key/edge regexes outside this
// file so the grammar cannot fork again.
//
// The grammar (hard rule, CLAUDE.md: regex-based, no YAML library — zero deps):
//   - `---` fence on the first line, closed by the next `---` line; CRLF and
//     LF both read (a CRLF file is written back CRLF — see joinDocument).
//   - `key: value` flat scalars (a wholly double-quoted value is unescaped per
//     YAML 1.2, a wholly single-quoted one folds `''`; else a lone
//     leading/trailing quote is stripped);
//     YAML-folded continuations (indented lines) join with single spaces.
//   - LIST_FIELDS as an inline list `key: [a, b]` or a block list (`key:` then
//     `- a` lines, flush-left or indented); any other key stays a scalar.
//   - `edges:` entries in flow form `- {type: X, to: Y[, k: v]*}` (also
//     recognized outside an edges block, wherever the line sits) or block form
//     (`- type: X` then indented `to: Y`), `target:` accepted for `to:`.
//   - Two DELIBERATE faults (tagged `sporParse`): no fence, and an edge entry
//     that resolves to no type+to (or a line in an edges block that opens
//     neither an entry nor a continuation).
//
// Exports:
//   LIST_FIELDS                            the block/inline-list key allowlist
//   splitDocument(raw) -> {frontmatter, body, crlf} | null   (the ONE fence read)
//   joinDocument(doc) -> raw               fence + line-ending style restored
//   lexFrontmatter(fm, file, {lenient})    -> {fields, entries, edges, faults}
//   parseFrontmatter(raw, file)            -> node (throws the first fault)
//   readNode(raw, file)                    -> {node, faults} | null (lenient: lint)
//   serializeNode(node)                    -> canonical raw markdown
//   sameEdge(a, b, renames)                parsed-identity edge equality
//   withEdge / withoutEdge / withStamp / withKey / withKeyAfter   editors
"use strict";

// The keys parseFrontmatter reads as LISTS. Inline `key: [a, b]` or a YAML
// block list (`key:` alone on its line, `- item` lines below). pin/exclude are
// corrections, queue_mute a person's mutes, commits the repo@sha stamps,
// slugs/fingerprints/roles/tags repo & person registers, applies_to_* the norm
// ride-along scope, couples_* the coupling anchors, skills/plugins/mcp/requires
// the profile/dispatch axes, failing_tests the escalation's structured list
// and covers_tests the tests a flake issue declares it covers — all flat
// strings, never objects, by parser design.
const LIST_FIELDS = ["pin", "exclude", "queue_mute", "commits", "slugs", "fingerprints", "roles", "tags",
  "applies_to_tags", "applies_to_repos", "applies_to_projects", "couples_when", "couples_also",
  "skills", "plugins", "mcp", "requires", "failing_tests", "covers_tests"];
const LIST_FIELD_SET = new Set(LIST_FIELDS);

// The grammar's regexes — defined ONCE, here.
const FENCE_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const LIST_FIELD_RE = new RegExp(`^(${LIST_FIELDS.join("|")}):\\s*\\[([^\\]]*)\\]`);
const KV_RE = /^(\w[\w-]*):\s*(.*)$/;
// Flow-form edge, anywhere on the line: `- {type: X, to: Y}` (or `target:`)
// plus any trailing flat `, k: v` attributes (preserved on the edge object —
// the per-assignment profile override, dec-spor-orchestration-routine-
// requires-threads thread 3). `[\w-]+` for `to` must be followed by `,` or
// `}`, so a match on `agent-x` never covers `agent-x-2`.
const FLOW_EDGE_RE = /-\s*\{type:\s*([\w-]+),\s*(?:to|target):\s*([\w-]+)((?:\s*,\s*[\w-]+:\s*[\w-]+)*)\}/;
const FLOW_ATTR_RE = /,\s*([\w-]+):\s*([\w-]+)/g;
const BLOCK_OPEN_RE = /^\s*-\s+(\w[\w-]*):\s*(.*)$/;
const BLOCK_CONT_RE = /^\s+(\w[\w-]*):\s*(.*)$/;
const LIST_ITEM_RE = /^\s*-\s+(\S.*)$/;
const CONT_RE = /^\s+(\S.*)$/;

const unquote = (s) => s.replace(/^["']|["']$/g, "");

// YAML 1.2 double-quoted escapes; an unknown escape stays literal (a Windows
// path like "C:\dir" must not lose its backslash).
const DQ_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", 0: "\0", '"': '"', "\\": "\\", "/": "/", " ": " " };
const unescapeDouble = (s) => s.replace(/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g, (m, u, x, c) => {
  if (u || x) return String.fromCharCode(parseInt(u || x, 16));
  return Object.prototype.hasOwnProperty.call(DQ_ESCAPES, c) ? DQ_ESCAPES[c] : m;
});
// A flat scalar's value: a WHOLLY double-quoted value is unescaped (so a
// JSON.stringify'd title round-trips), a wholly single-quoted one folds `''`
// to `'`; anything else keeps the legacy strip of a lone leading/trailing quote.
const scalarValue = (s) => {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return unescapeDouble(t.slice(1, -1));
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return unquote(s);
};
// The ONE writer paired with scalarValue: the text to put after `key: ` / `- `
// so the read gives `v` back verbatim. Newlines fold to spaces (a scalar is one
// line); a value the read would trim, unwrap or unescape — or an empty block
// item, which the item grammar would drop — is JSON-quoted, which it reads back.
const emitScalar = (v, { quoteEmpty = false } = {}) => {
  const flat = String(v).replace(/\r?\n/g, " ");
  if (flat === "") return quoteEmpty ? '""' : flat;
  return flat.trim() === flat && scalarValue(flat) === flat ? flat : JSON.stringify(flat);
};
const isBlankOrComment = (line) => line.trim() === "" || line.trim().startsWith("#");

// A DELIBERATE parse fault — tagged so buildGraph's per-node isolation can
// tell "this file is malformed" (skip it, dec-spor-buildgraph-per-node-
// fault-isolation) from "this parser is broken" (a TypeError), which must
// still crash loudly rather than silently emptying the graph.
const parseFault = (message) => Object.assign(new Error(message), { sporParse: true });

// ---------- the fence ----------

// Split a raw node file at its frontmatter fence. `crlf` records the file's
// line-ending style (any CRLF present -> the whole file is CRLF on rewrite,
// issue-spor-rewrite-stamp-crlf-frontmatter); `frontmatter`/`body` are the
// LF-normalized texts between/after the fence. null when there is no fence.
function splitDocument(raw) {
  const text = String(raw ?? "");
  const crlf = /\r\n/.test(text);
  const norm = crlf ? text.replace(/\r\n/g, "\n") : text;
  const m = FENCE_RE.exec(norm);
  if (!m) return null;
  return { frontmatter: m[1], body: m[2], crlf };
}

// Reassemble what splitDocument took apart (or an edited copy of it),
// restoring the file's line-ending style.
function joinDocument({ frontmatter, body, crlf }) {
  const out = `---\n${frontmatter}\n---\n${body}`;
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

// ---------- the lexer ----------

// Read frontmatter text into line-ranged entries. Every range is [start, end)
// over `fm.split("\n")`.
//
//   fields   the folded key -> value map in document order (lists as arrays;
//            `edges` is NOT here — see `edges`)
//   entries  top-level entries: {kind: "scalar"|"list"|"edges", key, start,
//            end} — a scalar's range covers its folded continuations, a list's
//            its items, the edges entry's every line consumed under it
//   edges    every edge entry in document order: {edge: {type, to, ...attrs},
//            form: "flow"|"block", start, end}; flow edges outside an `edges:`
//            block are included (the parser has always read them)
//   faults   [{line, message}] — empty unless `lenient`, in which case an edge
//            fault is recorded and reading continues (the lint's posture:
//            one bad entry must not hide the rest of the file's problems)
//
// Strict mode (the default) throws the first fault as a parseFault.
function lexFrontmatter(fm, file = "node.md", { lenient = false } = {}) {
  const lines = String(fm).split("\n");
  const fields = {};
  const entries = [];
  const edges = [];
  const faults = [];
  // Fault messages name the offending entry only; strict mode appends the
  // file (the loader's "... in <file>" wording), the lint prefixes its own.
  const fault = (line, message) => {
    if (!lenient) throw parseFault(`${message} in ${file}`);
    faults.push({ line, message });
  };

  let cur = null; // the open top-level entry
  let lastKey = null; // a scalar awaiting folded continuations
  let lastRaw = null; // that scalar's unread text, re-read as a whole once folded
  let blockListKey = null; // a LIST_FIELD awaiting `- item` lines
  let inEdgesBlock = false;
  let edgeBuf = null; // a block-form edge entry under construction
  let edgeStart = -1;

  const extend = (i) => { if (cur) cur.end = i + 1; };
  const open = (entry) => { cur = entry; entries.push(entry); };
  const flushEdgeBuf = (i) => {
    if (!edgeBuf) return;
    const eb = edgeBuf, start = edgeStart;
    edgeBuf = null;
    edgeStart = -1;
    if (!eb.type || !eb.to) {
      fault(start, `unparseable edge entry ${JSON.stringify(eb)}`);
      return;
    }
    edges.push({ edge: eb, form: "block", start, end: i });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const list = line.match(LIST_FIELD_RE);
    if (list) {
      flushEdgeBuf(i);
      inEdgesBlock = false;
      fields[list[1]] = list[2].split(",").map((s) => s.trim()).filter(Boolean);
      open({ kind: "list", key: list[1], form: "inline", start: i, end: i + 1 });
      lastKey = null;
      blockListKey = null;
      continue;
    }
    const kv = line.match(KV_RE);
    if (kv) {
      flushEdgeBuf(i);
      if (kv[1] === "edges") {
        inEdgesBlock = true;
        open({ kind: "edges", key: "edges", start: i, end: i + 1 });
        lastKey = null;
        blockListKey = null;
      } else if (LIST_FIELD_SET.has(kv[1]) && kv[2].trim() === "") {
        inEdgesBlock = false;
        fields[kv[1]] = [];
        open({ kind: "list", key: kv[1], form: "block", start: i, end: i + 1 });
        lastKey = kv[1];
        blockListKey = kv[1];
      } else {
        inEdgesBlock = false;
        fields[kv[1]] = scalarValue(kv[2]);
        open({ kind: "scalar", key: kv[1], start: i, end: i + 1 });
        lastKey = kv[1];
        lastRaw = kv[2];
        blockListKey = null;
      }
      continue;
    }
    const flow = line.match(FLOW_EDGE_RE);
    if (flow) {
      flushEdgeBuf(i);
      const e = { type: flow[1], to: flow[2] };
      if (flow[3]) for (const a of flow[3].matchAll(FLOW_ATTR_RE)) e[a[1]] = a[2];
      edges.push({ edge: e, form: "flow", start: i, end: i + 1 });
      if (inEdgesBlock) extend(i);
      continue;
    }
    if (inEdgesBlock) {
      // Block-form edge: `- type: X` (or `- to:`/`- target:`, any key first)
      // opens an entry; indented `key: value` lines fold onto it until the
      // next item or a new top-level key closes it. A line that does neither
      // is unparseable.
      const bo = line.match(BLOCK_OPEN_RE);
      if (bo) {
        flushEdgeBuf(i);
        edgeBuf = {};
        edgeStart = i;
        edgeBuf[bo[1] === "target" ? "to" : bo[1]] = scalarValue(bo[2].trim());
        extend(i);
        continue;
      }
      const bc = edgeBuf && line.match(BLOCK_CONT_RE);
      if (bc) {
        edgeBuf[bc[1] === "target" ? "to" : bc[1]] = scalarValue(bc[2].trim());
        extend(i);
        continue;
      }
      if (isBlankOrComment(line)) { extend(i); continue; }
      fault(i, `unparseable edge entry "${line.trim()}"`);
      continue;
    }
    if (blockListKey) {
      // A block list is open: `- item` lines may sit flush-left (valid YAML)
      // or indented. ANY other line while the list is open is ignored — never
      // folded onto the array (issue-spor-graph-block-list-fix-array-
      // corruption-regression).
      const item = line.match(LIST_ITEM_RE);
      if (item) { fields[blockListKey].push(scalarValue(item[1].trim())); extend(i); }
      continue;
    }
    const cont = line.match(CONT_RE);
    if (cont && lastKey) {
      // A quoted scalar whose closing quote has not arrived yet is read once
      // whole when it does; any other keeps the legacy join.
      const t = lastRaw.trim();
      if (/^["']/.test(t) && !/^(?:"(?:[^"\\]|\\[\s\S])*"|'(?:[^']|'')*')$/.test(t)) {
        lastRaw += ` ${cont[1].trim()}`;
        fields[lastKey] = scalarValue(lastRaw);
      } else fields[lastKey] += ` ${cont[1].trim()}`;
      extend(i);
    }
  }
  flushEdgeBuf(lines.length);
  return { fields, entries, edges, faults, lines };
}

// ---------- reading ----------

// Fold a lex into the node object every consumer keys on. Key order is the
// document's (edges/pin/exclude first, then keys as they appear, then body/
// file) — byte-identical to the pre-module parser's construction order.
function foldNode(lex, body, file) {
  const node = { edges: lex.edges.map((e) => e.edge), pin: [], exclude: [], body: String(body).trim(), file };
  for (const [k, v] of Object.entries(lex.fields)) node[k] = v;
  // The provenance STAMP key is `repo:` (dec-cc-repo-project-two-layer-
  // identity); the legacy `project:` key is still read. Both populate
  // `n.project` — the canonical field every consumer keys on — with `repo:`
  // winning when both are present, mirroring the `.spor` marker rule.
  if (node.repo != null) node.project = node.repo;
  return node;
}

// The loader's read: a node object, or the first fault thrown.
function parseFrontmatter(raw, file) {
  const doc = splitDocument(raw);
  if (!doc) throw parseFault(`no frontmatter in ${file}`);
  return foldNode(lexFrontmatter(doc.frontmatter, file), doc.body, file);
}

// The lint's read: the same node, every fault RECORDED rather than thrown
// (an edge entry that faults is dropped, the rest of the file still folds).
// null when there is no fence at all — the one fault nothing can read past.
function readNode(raw, file) {
  const doc = splitDocument(raw);
  if (!doc) return null;
  const lex = lexFrontmatter(doc.frontmatter, file, { lenient: true });
  return { node: foldNode(lex, doc.body, file), faults: lex.faults.map((f) => f.message) };
}

// ---------- writing ----------

const SIMPLE_TOKEN = /^[\w-]+$/;
const inlineSafe = (s) => !/[,\[\]]/.test(s) && !/^["']|["']$/.test(s) && s.trim() === s && s !== "";

// Serialize a node object to canonical markdown: `id` and `type` first, then
// keys in the node's own order (`edges`, `body`, `file` set aside), lists inline when every item survives
// the inline read (block form otherwise), edges last in flow form when every
// value is a bare token (block form otherwise), then the body. Round-trip
// law: parseFrontmatter(serializeNode(n)) folds to the same fields, edges and
// body as n (pinned by the conformance `frontmatter` kind). Empty default
// `pin`/`exclude` lists are omitted — they read back as [] either way.
function serializeNode(node) {
  const lines = [];
  const keys = [...new Set(["id", "type", ...Object.keys(node)])].filter((k) => k in node);
  for (const k of keys) {
    const v = node[k];
    if (k === "edges" || k === "body" || k === "file") continue;
    if (Array.isArray(v)) {
      const items = v.map((x) => String(x));
      if (items.length === 0) {
        if (k === "pin" || k === "exclude") continue;
        lines.push(`${k}: []`);
      } else if (items.every(inlineSafe)) {
        lines.push(`${k}: [${items.join(", ")}]`);
      } else {
        lines.push(`${k}:`);
        for (const it of items) lines.push(`  - ${emitScalar(it, { quoteEmpty: true })}`);
      }
      continue;
    }
    if (v == null) continue;
    // A value the scalar read would not give back verbatim (wrapping quotes,
    // or an escape-looking backslash run) is written JSON-quoted, which it does.
    lines.push(`${k}: ${emitScalar(v)}`);
  }
  const edges = Array.isArray(node.edges) ? node.edges : [];
  if (edges.length) {
    lines.push("edges:");
    for (const e of edges) {
      const attrs = Object.entries(e).filter(([k, v]) => k !== "type" && k !== "to" && v != null && v !== "");
      const flowable = SIMPLE_TOKEN.test(String(e.type)) && SIMPLE_TOKEN.test(String(e.to))
        && attrs.every(([k, v]) => SIMPLE_TOKEN.test(k) && SIMPLE_TOKEN.test(String(v)));
      if (flowable) {
        lines.push(`  - {type: ${e.type}, to: ${e.to}${attrs.map(([k, v]) => `, ${k}: ${v}`).join("")}}`);
      } else {
        lines.push(`  - type: ${emitScalar(e.type, { quoteEmpty: true })}`);
        lines.push(`    to: ${emitScalar(e.to, { quoteEmpty: true })}`);
        for (const [k, v] of attrs) lines.push(`    ${k}: ${emitScalar(v)}`);
      }
    }
  }
  const body = String(node.body ?? "").trim();
  return `---\n${lines.join("\n")}\n---\n${body ? `\n${body}\n` : ""}`;
}

// ---------- edge identity ----------

// An edge type in the registry's canonical spelling. The parser never
// canonicalizes, so a hand-authored node may carry a legacy ALIAS verbatim
// (`related-to`, `supercedes`) while a caller asks for the canonical type;
// both sides pass through this before any equality test (issue-spor-cmd-edge-
// alias-spelling-not-canonicalized). Comparison-time only: a file's own
// spelling is never rewritten. `renames` is `registry.edgeRenames()`; absent,
// it degrades to a raw spelling match.
const canonEdgeType = (type, renames) => (renames && renames[type]) || type;

// Parsed-identity equality: same canonical type, same target.
function sameEdge(a, b, renames) {
  return canonEdgeType(a.type, renames) === canonEdgeType(b.type, renames) && a.to === b.to;
}

// ---------- editors ----------
// Each takes a raw node file and returns the rewritten raw, or null when the
// frontmatter cannot be located (and, for withoutEdge, when nothing matched).
// They splice by entry RANGE, so every byte outside the touched entry —
// ordering, comments, the body, the line-ending style — is preserved.

function editDocument(raw, edit) {
  const doc = splitDocument(raw);
  if (!doc) return null;
  const lex = lexFrontmatter(doc.frontmatter, "node.md", { lenient: true });
  const lines = lex.lines.slice();
  const r = edit(lines, lex);
  if (r === null) return null;
  return joinDocument({ ...doc, frontmatter: lines.join("\n") });
}

// Remove the given ranges from `lines`, highest first so earlier indexes hold.
function spliceRanges(lines, ranges) {
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) lines.splice(r.start, r.end - r.start);
}

// Render one flow-form edge line: `  - {type: T, to: TO[, k: v]*}`, attrs in
// key order with empty values dropped (mirrors the server's insertEdgeLine).
function edgeLine(type, to, attrs) {
  const tail = attrs
    ? Object.keys(attrs).filter((k) => attrs[k] != null && attrs[k] !== "").sort().map((k) => `, ${k}: ${attrs[k]}`).join("")
    : "";
  return `  - {type: ${type}, to: ${to}${tail}}`;
}

// Append an edge: after the last existing edge entry when one follows the
// `edges:` key, else right after the key; the block is created at the end of
// the frontmatter when absent.
function withEdge(raw, type, to, attrs) {
  return editDocument(raw, (lines, lex) => {
    const line = edgeLine(type, to, attrs);
    const keys = lex.entries.filter((e) => e.kind === "edges");
    const edgesKey = keys.length ? keys[keys.length - 1].start : -1;
    const lastEdgeEnd = lex.edges.reduce((m, e) => Math.max(m, e.end), -1);
    if (edgesKey === -1) lines.push("edges:", line);
    else lines.splice(lastEdgeEnd > edgesKey ? lastEdgeEnd : edgesKey + 1, 0, line);
  });
}

// Remove the FIRST edge entry matching by parsed identity — flow or block
// form alike, every line of a block entry (issue-spor-edge-remove-misses-
// block-style-yaml-edges, issue-spor-remove-edge-line-flow-form-only-retract-
// never-converges). `match` is either {type, to} (compared through `renames`
// via sameEdge) or a predicate over the parsed edge object. null when no
// entry matches — the caller reports the idempotent skip.
function withoutEdge(raw, match, renames) {
  const pred = typeof match === "function" ? match : (e) => sameEdge(e, match, renames);
  return editDocument(raw, (lines, lex) => {
    const hit = lex.edges.find((e) => pred(e.edge));
    if (!hit) return null;
    spliceRanges(lines, [hit]);
  });
}

// Replace a family of stamp keys: every entry whose key is in `keys` is
// removed (continuations included), blank lines at either end of the
// frontmatter are trimmed, and `stampLines` are appended at the end of the
// block — the shape of the server's rewrite<Field>/forceStatus, so a local
// node and a remote one read the same after the mutation.
function withStamp(raw, keys, stampLines) {
  const drop = new Set(keys);
  return editDocument(raw, (lines, lex) => {
    spliceRanges(lines, lex.entries.filter((e) => drop.has(e.key)));
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    while (lines.length && lines[0] === "") lines.shift();
    lines.push(...stampLines);
  });
}

// Set (or, with null, remove) ONE flat key, leaving every other line byte-
// for-byte: in place when the key exists (the file's own ordering is kept),
// else inserted before `edges:` (a flat key after the edge block would be read
// as part of it by a hand editor), else appended.
function withKey(raw, key, value) {
  return editDocument(raw, (lines, lex) => {
    const own = lex.entries.filter((e) => e.key === key && e.kind !== "edges");
    if (value == null) { spliceRanges(lines, own); return; }
    const line = `${key}: ${value}`;
    if (own.length) {
      const first = own[0];
      spliceRanges(lines, own);
      lines.splice(first.start, 0, line);
      return;
    }
    const edges = lex.entries.find((e) => e.kind === "edges");
    if (edges) lines.splice(edges.start, 0, line);
    else lines.push(line);
  });
}

// Replace a key wholesale and place it after the last of the `anchorKeys`
// entries when one is present, else at the end of the frontmatter. `line`
// null removes the key. (rewriteTags: the inline `tags:` register sits with
// the other identity registers, after fingerprints/slugs.)
function withKeyAfter(raw, key, line, anchorKeys) {
  const anchors = new Set(anchorKeys || []);
  return editDocument(raw, (lines, lex) => {
    const own = lex.entries.filter((e) => e.key === key && e.kind !== "edges");
    spliceRanges(lines, own);
    if (line == null) return;
    const removedBefore = (i) => own.filter((e) => e.end <= i).reduce((n, e) => n + (e.end - e.start), 0);
    const anchor = lex.entries.filter((e) => anchors.has(e.key) && e.kind !== "edges").pop();
    if (!anchor) lines.push(line);
    else lines.splice(anchor.end - removedBefore(anchor.end), 0, line);
  });
}

module.exports = {
  LIST_FIELDS,
  parseFault,
  splitDocument,
  joinDocument,
  lexFrontmatter,
  parseFrontmatter,
  readNode,
  serializeNode,
  canonEdgeType,
  sameEdge,
  edgeLine,
  withEdge,
  withoutEdge,
  withStamp,
  withKey,
  withKeyAfter,
};
