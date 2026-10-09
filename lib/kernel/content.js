"use strict";
// kernel/content.js — the graph-native CONTENT contracts
// (task-spor-chatgpt-content-contracts, Phase 1 of the ChatGPT workspace
// program, art-spor-chatgpt-workspace-plan-2026-10-08). Pure: data in, data
// out, no I/O. The only builtin it touches is `crypto`, for the one digest
// whose definition it owns (documentDigest), the same way kernel/gates.js
// owns definitionDigest.
//
// What it defines, all of it OPTIONAL and backward-readable — a node that
// carries none of these keys is exactly what it was (GRAPH.md "Rich content
// and assets"):
//
//   1. content_format     an artifact's body format: `markdown` (CommonMark +
//                         GFM, where `spor-asset:` image embeds MEAN something)
//                         or `text` (plain, no markup). Absent = legacy: the
//                         body is read the way it always was, and it embeds
//                         nothing.
//   2. asset descriptor   an ordinary artifact naming immutable bytes held
//                         OUTSIDE graph Git (dec-spor-chatgpt-asset-storage-
//                         contract-2026-10-08): flat scalars asset_digest /
//                         asset_media_type / asset_bytes / asset_width /
//                         asset_height (+ optional asset_alt). All or none of
//                         the required five; an unknown `asset_*` key is a
//                         typo and is refused.
//   3. asset URIs         `spor-asset:<descriptor-id>[@sha256:<hex>]` — the
//                         stable spelling a markdown body embeds an asset by.
//                         The id is the stable handle (it is what a `uses-asset`
//                         edge points at); the optional pin binds the exact
//                         bytes. Only INLINE IMAGE syntax outside code counts as
//                         an embed: a URI in a code fence or code span is an
//                         example, not an embedding.
//   4. document digests   doc_sha256 / doc_bytes on a generation root and
//                         doc_generation on its parts, the server's long-
//                         document stamps (dec-spor-document-generations-
//                         contract-2026-10-08), validated for SHAPE here.
//   5. snapshots          {root, revision, doc_sha256?, doc_bytes?, parts:
//                         [{id, revision}]} — one exact document as read.
//   6. selections         a SOURCE range (UTF-16 code-unit offsets into one
//                         exact document) or an IMAGE region (pixels of one
//                         exact asset digest), as a JSON object and as a
//                         single-scalar URI (`spor-source:` / `spor-image:`),
//                         so a node carries one without nested frontmatter.
//
// FOUR identities that must never be confused (GRAPH.md spells them out):
//   - a node REVISION is the git blob sha of the node FILE (frontmatter
//     included) — what every read returns and every update CASes on;
//   - doc_sha256 is sha256 of the document's canonical body CORE (the
//     reassembled text, no frontmatter) — the same text can sit under many
//     revisions (an edge write moves the revision, never the digest);
//   - doc_generation on a part is the doc_sha256 of the document it is a
//     slice of, not a digest of the part;
//   - asset_digest is `sha256:<hex>` over the asset's BYTES.
//
// The write-door rejection lives in the seed `schema-artifact` validate()
// (sandboxed attached code cannot require this module), which carries an
// inline copy of validateContentFields's rules; test/content.test.js pins the
// two to the same verdicts over one corpus. A graph-resident schema-artifact
// overrides both — the registry stays the contract.

const crypto = require("crypto");

const NODE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_ID_LENGTH = 200;
const HEX64_RE = /^[0-9a-f]{64}$/;
// A node revision is a git blob sha: 40 hex (sha1 repos) or 64 (sha256 repos).
const REVISION_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ASSET_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const UINT_RE = /^(?:0|[1-9][0-9]*)$/;

const CONTENT_FORMATS = ["markdown", "text"];
// Image types the server's single-pass verifier can probe (PNG/JPEG/GIF/WebP).
// SVG is excluded on purpose: it is a document that can carry script.
const ASSET_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const ASSET_REQUIRED_KEYS = ["asset_digest", "asset_media_type", "asset_bytes", "asset_width", "asset_height"];
const ASSET_OPTIONAL_KEYS = ["asset_alt"];
const ASSET_KEYS = [...ASSET_REQUIRED_KEYS, ...ASSET_OPTIONAL_KEYS];
const MAX_ALT_CHARS = 1000;
// The edge a document carries to each asset descriptor it embeds. Its schema
// is a CANDIDATE (lib/seed/candidates/schema-edge-uses-asset.md): its weight
// and flags come from the live registry, never from here.
const USES_ASSET = "uses-asset";

const ASSET_SCHEME = "spor-asset:";
const SOURCE_SCHEME = "spor-source:";
const IMAGE_SCHEME = "spor-image:";

function str(v) {
  return v == null ? "" : String(v);
}
function present(v) {
  return v != null && String(v) !== "";
}
function validId(id) {
  return typeof id === "string" && id.length <= MAX_ID_LENGTH && NODE_ID_RE.test(id);
}
// A positive (or, with allowZero, non-negative) canonical decimal integer, as
// frontmatter carries it (a string) or as JSON does (a number).
function uint(v, { allowZero = false } = {}) {
  const s = typeof v === "number" ? (Number.isInteger(v) ? String(v) : "") : str(v);
  if (!UINT_RE.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || (!allowZero && n === 0)) return null;
  return n;
}

// ---------------------------------------------------------------------------
// Document digest. The CORE is the canonical stored body minus its wrapping
// newlines — exactly what spor-server's documentGeneration hashes (leading
// "\n"s dropped, trailing whitespace trimmed). Selection offsets index this
// string.
function documentCore(body) {
  return str(body).replace(/^\n+/, "").trimEnd();
}
function documentDigest(core) {
  return crypto.createHash("sha256").update(str(core), "utf8").digest("hex");
}
function documentBytes(core) {
  return Buffer.byteLength(str(core), "utf8");
}

// ---------------------------------------------------------------------------
// Asset URIs.

// parseAssetUri("spor-asset:art-x@sha256:<hex>") -> {ok, id, digest|null} |
// {ok:false, error}.
function parseAssetUri(uri) {
  const s = str(uri);
  if (!s.startsWith(ASSET_SCHEME)) return { ok: false, error: `not a ${ASSET_SCHEME} URI` };
  const rest = s.slice(ASSET_SCHEME.length);
  const at = rest.indexOf("@");
  const id = at === -1 ? rest : rest.slice(0, at);
  const pin = at === -1 ? null : rest.slice(at + 1);
  if (!validId(id)) return { ok: false, error: `asset URI '${s}': '${id}' is not a node id` };
  if (pin !== null && !ASSET_DIGEST_RE.test(pin)) {
    return { ok: false, error: `asset URI '${s}': pin must be sha256:<64 lowercase hex>` };
  }
  return { ok: true, id, digest: pin };
}
function formatAssetUri({ id, digest = null }) {
  if (!validId(id)) throw new Error(`formatAssetUri: '${id}' is not a node id`);
  if (digest != null && !ASSET_DIGEST_RE.test(digest)) throw new Error(`formatAssetUri: bad digest '${digest}'`);
  return `${ASSET_SCHEME}${id}${digest ? `@${digest}` : ""}`;
}

// ---------------------------------------------------------------------------
// Embed extraction. Scans a markdown body for INLINE IMAGES whose destination
// is a spor-asset: URI, skipping everything that is not rendered as an image.
// Block level, line by line:
//   - fenced code blocks (``` / ~~~), tracked with the CONTAINER they opened
//     in: their blockquote depth and column, and whether they sit in a list
//     item. A fence closes only on a marker line at that same depth and
//     column (<= 3 columns deeper; at top level, <= 3 spaces), and it also
//     ends when its container does: a line with fewer `>` markers, or a
//     non-blank line left of a list item's content column. An unclosed fence
//     otherwise runs to the end;
//   - HTML blocks whose content is never markdown: a line opening with `<!--`
//     runs to the line holding `-->` (that same line, when it closes there),
//     and one opening with `<pre>`, `<script>`, `<style>` or `<textarea>` to
//     its closing tag's line;
//   - blank lines end a paragraph, so no code span or image crosses one.
// Inline, within each paragraph: code spans, HTML comments and backslash
// escapes. A plain link `[x](spor-asset:…)` is a reference, not an embedding.
// Indented (4-space) code blocks, reference-style images and an image whose
// destination continues onto a `>`-prefixed line are NOT recognized — fence
// examples instead (GRAPH.md).
//
// Returns [{uri, id, digest, alt, start, end}] in document order, offsets in
// UTF-16 code units of `text`; a spor-asset: destination that does not parse
// comes back with `error` instead of id/digest.
const LIST_MARKER_RE = /^(?:[-*+]|[0-9]{1,9}[.)])(?:[ \t]+|$)/;
const RAW_BLOCK_RE = /^<(pre|script|style|textarea)(?=[\s>]|$)/i;
const FENCE_OPEN_RE = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^(`+|~+)[ \t]*$/;

// A line's container prefix: blockquote depth, the column of its content
// (after the last `>`), whether a list marker opened on it (only read on a
// line that may OPEN a block — a continuation line's marker is content), and
// the rest of the line.
function containers(line, markers) {
  let i = 0, depth = 0, col = 0, listed = false;
  for (;;) {
    let j = i;
    while (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
    if (line[j] === ">") {
      depth++;
      i = j + 1;
      if (line[i] === " ") i++;
      col = 0;
      listed = false;
      continue;
    }
    const m = markers ? LIST_MARKER_RE.exec(line.slice(j)) : null;
    if (m) {
      col += j - i + m[0].length;
      i = j + m[0].length;
      listed = true;
      continue;
    }
    col += j - i;
    return { depth, col, listed, rest: line.slice(j) };
  }
}

function extractAssetEmbeds(text) {
  const src = str(text);
  const out = [];
  const lines = src.split("\n");
  let pos = 0;
  let fence = null; // {ch, len, depth, col, list, content}
  let raw = null; // the closing marker of an open HTML block
  let segStart = 0;
  const flush = (end) => {
    if (end > segStart) scanInline(src, segStart, end, out);
  };
  for (const line of lines) {
    const lineEnd = pos + line.length;
    const next = Math.min(lineEnd + 1, src.length);
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    const c = containers(bare, false);
    if (fence) {
      const left = c.depth < fence.depth ||
        (fence.list && c.depth === fence.depth && c.rest !== "" && c.col < fence.content);
      if (!left) {
        const close = c.depth === fence.depth ? FENCE_CLOSE_RE.exec(c.rest) : null;
        if (close && close[1][0] === fence.ch && close[1].length >= fence.len &&
            c.col <= (fence.list ? fence.col + 3 : 3)) {
          fence = null;
          segStart = next;
        }
        pos = lineEnd + 1;
        continue;
      }
      // the fence's container ended with it; this line starts fresh
      fence = null;
      segStart = pos;
    }
    if (raw) {
      if (c.rest.toLowerCase().includes(raw)) {
        raw = null;
        segStart = next;
      }
    } else if (c.rest === "") {
      flush(pos);
      segStart = next;
    } else {
      const o = containers(bare, true);
      const open = FENCE_OPEN_RE.exec(o.rest);
      const block = RAW_BLOCK_RE.exec(c.rest);
      if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
        flush(pos);
        const list = o.listed || o.col >= 4;
        fence = { ch: open[1][0], len: open[1].length, depth: o.depth, col: o.col, list,
          content: o.listed ? o.col : o.col - 3 };
      } else if (c.rest.startsWith("<!--") || block) {
        // an HTML block: the whole line (and, unclosed, every line to the
        // closer's) is raw HTML, never markdown
        const lower = c.rest.toLowerCase();
        const closes = block ? lower.includes(`</${block[1].toLowerCase()}>`)
          : /^<!---?>/.test(c.rest) || c.rest.includes("-->", 4);
        flush(pos);
        if (closes) segStart = next;
        else raw = block ? `</${block[1].toLowerCase()}>` : "-->";
      }
    }
    pos = lineEnd + 1;
  }
  if (!fence && !raw) flush(src.length);
  return out;
}

// Scan [from, to) of src for inline images, honoring code spans, comments and
// escapes. Code spans and images may cross line breaks, never a fence (the
// caller only hands over fence-free segments).
function scanInline(src, from, to, out) {
  let i = from;
  while (i < to) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") {
      let n = 0;
      while (i + n < to && src[i + n] === "`") n++;
      const close = findBacktickRun(src, i + n, to, n);
      i = close === -1 ? i + n : close + n;
      continue;
    }
    if (c === "<" && src.startsWith("<!--", i)) {
      const empty = /^<!---?>/.exec(src.slice(i, i + 6));
      if (empty) { i += empty[0].length; continue; }
      const end = src.indexOf("-->", i + 4);
      i = end === -1 || end >= to ? to : end + 3;
      continue;
    }
    if (c === "!" && src[i + 1] === "[") {
      const img = parseInlineImage(src, i, to);
      if (img) {
        if (img.dest.startsWith(ASSET_SCHEME)) {
          const p = parseAssetUri(img.dest);
          const e = { uri: img.dest, alt: img.alt, start: i, end: img.end };
          if (p.ok) { e.id = p.id; e.digest = p.digest; } else e.error = p.error;
          out.push(e);
        }
        i = img.end;
        continue;
      }
    }
    i++;
  }
}
function findBacktickRun(src, from, to, n) {
  let i = from;
  while (i < to) {
    if (src[i] !== "`") { i++; continue; }
    let m = 0;
    while (i + m < to && src[i + m] === "`") m++;
    if (m === n) return i;
    i += m;
  }
  return -1;
}
// `![alt](dest "title")` starting at i (src[i] === "!"). Returns {alt, dest,
// end} or null. Alt text may hold balanced brackets; the destination is
// `<…>` or a run without spaces/controls (balanced parens allowed).
function parseInlineImage(src, i, to) {
  let j = i + 2;
  let depth = 1;
  while (j < to) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "`") {
      // a code span in the alt text owns its brackets
      let n = 0;
      while (j + n < to && src[j + n] === "`") n++;
      const close = findBacktickRun(src, j + n, to, n);
      j = close === -1 ? j + n : close + n;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
    j++;
  }
  if (j >= to || src[j + 1] !== "(") return null;
  const alt = src.slice(i + 2, j);
  let k = j + 2;
  while (k < to && (src[k] === " " || src[k] === "\t" || src[k] === "\n")) k++;
  let dest;
  if (src[k] === "<") {
    const end = src.indexOf(">", k + 1);
    if (end === -1 || end >= to || src.slice(k + 1, end).includes("\n")) return null;
    dest = src.slice(k + 1, end);
    k = end + 1;
  } else {
    const s = k;
    let paren = 0;
    while (k < to) {
      const c = src[k];
      if (c === "\\") { k += 2; continue; }
      if (c <= " ") break;
      if (c === "(") paren++;
      else if (c === ")") { if (paren === 0) break; paren--; }
      k++;
    }
    dest = src.slice(s, k);
  }
  while (k < to && (src[k] === " " || src[k] === "\t" || src[k] === "\n")) k++;
  const q = src[k];
  if (q === '"' || q === "'" || q === "(") {
    const closer = q === "(" ? ")" : q;
    let t = k + 1;
    while (t < to && src[t] !== closer) t += src[t] === "\\" ? 2 : 1;
    if (t >= to) return null;
    k = t + 1;
    while (k < to && (src[k] === " " || src[k] === "\t" || src[k] === "\n")) k++;
  }
  if (src[k] !== ")") return null;
  return { alt, dest, end: k + 1 };
}

// The embeds a NODE declares: only a `content_format: markdown` body embeds
// anything — a legacy (format-less) or `text` body declares none, so legacy
// nodes are never reinterpreted.
function nodeAssetEmbeds(node) {
  if (!node || str(node.content_format) !== "markdown") return [];
  return extractAssetEmbeds(documentCore(node.body));
}

// reconcileAssetEdges(node, {resolve}) — the inclusion-edge reconciliation the
// strict phase enforces once uses-asset is ACTIVE (task-spor-chatgpt-asset-
// schema-activation). Pure report, enforces nothing:
//   missing   descriptor ids embedded with no uses-asset edge
//   extra     uses-asset targets the body no longer embeds
//   malformed embeds whose spor-asset: URI does not parse
//   mismatch  pinned embeds whose digest disagrees with the descriptor
//             (`resolve(id)` -> the descriptor's frontmatter, or null)
//   unresolved embedded ids `resolve` could not find (or not a descriptor)
function reconcileAssetEdges(node, { resolve = null } = {}) {
  const embeds = nodeAssetEmbeds(node);
  const edges = Array.isArray(node && node.edges) ? node.edges : [];
  const declared = new Set(edges.filter((e) => e && e.type === USES_ASSET).map((e) => e.to));
  const embedded = new Set();
  const report = { missing: [], extra: [], malformed: [], mismatch: [], unresolved: [] };
  for (const e of embeds) {
    if (e.error) { report.malformed.push({ uri: e.uri, start: e.start, error: e.error }); continue; }
    if (!embedded.has(e.id)) {
      embedded.add(e.id);
      if (!declared.has(e.id)) report.missing.push(e.id);
    }
    if (resolve) {
      const d = assetDescriptor(resolve(e.id));
      if (!d) { if (!report.unresolved.includes(e.id)) report.unresolved.push(e.id); }
      else if (e.digest && e.digest !== d.digest) report.mismatch.push({ id: e.id, pinned: e.digest, current: d.digest });
    }
  }
  for (const to of declared) if (!embedded.has(to)) report.extra.push(to);
  return report;
}

// ---------------------------------------------------------------------------
// Asset descriptors.

// Errors for a node's asset_* keys ([] when it carries none).
function validateAssetDescriptor(fm) {
  const f = fm || {};
  const errs = [];
  const keys = Object.keys(f).filter((k) => k.startsWith("asset_") && present(f[k]));
  if (keys.length === 0) return errs;
  for (const k of keys) if (!ASSET_KEYS.includes(k)) errs.push(`unknown asset key '${k}' (known: ${ASSET_KEYS.join(", ")})`);
  const missing = ASSET_REQUIRED_KEYS.filter((k) => !present(f[k]));
  if (missing.length) errs.push(`asset descriptor is missing ${missing.join(", ")} (an asset descriptor carries all of ${ASSET_REQUIRED_KEYS.join(", ")})`);
  if (present(f.asset_digest) && !ASSET_DIGEST_RE.test(str(f.asset_digest))) errs.push(`asset_digest '${str(f.asset_digest)}' must be sha256:<64 lowercase hex>`);
  if (present(f.asset_media_type) && !ASSET_MEDIA_TYPES.includes(str(f.asset_media_type))) {
    errs.push(`asset_media_type '${str(f.asset_media_type)}' is not one of ${ASSET_MEDIA_TYPES.join(", ")}`);
  }
  for (const k of ["asset_bytes", "asset_width", "asset_height"]) {
    if (present(f[k]) && uint(f[k]) === null) errs.push(`${k} '${str(f[k])}' must be a positive integer`);
  }
  if (present(f.asset_alt) && str(f.asset_alt).length > MAX_ALT_CHARS) errs.push(`asset_alt is over ${MAX_ALT_CHARS} chars`);
  return errs;
}
// The parsed descriptor, or null when the node is not a VALID descriptor.
function assetDescriptor(fm) {
  if (!fm || !present(fm.asset_digest) || validateAssetDescriptor(fm).length) return null;
  return {
    id: fm.id ?? null,
    digest: str(fm.asset_digest),
    media_type: str(fm.asset_media_type),
    bytes: uint(fm.asset_bytes),
    width: uint(fm.asset_width),
    height: uint(fm.asset_height),
    alt: present(fm.asset_alt) ? str(fm.asset_alt) : null,
  };
}

// ---------------------------------------------------------------------------
// Document stamps (shape only — the exact-body check needs the reassembled
// document and belongs to the reader).
function validateDocumentStamps(fm) {
  const f = fm || {};
  const errs = [];
  const hasDigest = present(f.doc_sha256);
  const hasBytes = present(f.doc_bytes);
  if (hasDigest !== hasBytes) errs.push("doc_sha256 and doc_bytes come together (a generation root carries both)");
  if (hasDigest && !HEX64_RE.test(str(f.doc_sha256))) errs.push(`doc_sha256 '${str(f.doc_sha256)}' must be 64 lowercase hex`);
  if (hasBytes && uint(f.doc_bytes, { allowZero: true }) === null) errs.push(`doc_bytes '${str(f.doc_bytes)}' must be a non-negative integer`);
  if (present(f.doc_generation)) {
    if (!HEX64_RE.test(str(f.doc_generation))) errs.push(`doc_generation '${str(f.doc_generation)}' must be 64 lowercase hex`);
    if (!present(f.continuation_of)) errs.push("doc_generation marks a generation PART and needs continuation_of");
    if (hasDigest) errs.push("doc_generation (a part) and doc_sha256 (a root) are mutually exclusive");
  }
  return errs;
}

// A document snapshot: one exact document as read. `revision` pins the root
// file; each part's `revision` pins that part file. For a GENERATION root
// (doc_sha256 present) the parts are immutable and content-addressed, so the
// root revision alone already pins the text and the part revisions are
// redundant evidence; for a LEGACY spill (no doc_sha256) parts are mutable and
// the part revisions are what make the snapshot exact.
function validateDocumentSnapshot(snap) {
  const s = snap || {};
  const errs = [];
  if (!validId(s.root)) errs.push(`snapshot root '${str(s.root)}' is not a node id`);
  if (!REVISION_RE.test(str(s.revision))) errs.push(`snapshot revision '${str(s.revision)}' must be a git blob sha (40 or 64 hex)`);
  const hasDigest = present(s.doc_sha256);
  if (hasDigest !== present(s.doc_bytes)) errs.push("snapshot doc_sha256 and doc_bytes come together");
  if (hasDigest && !HEX64_RE.test(str(s.doc_sha256))) errs.push("snapshot doc_sha256 must be 64 lowercase hex");
  if (present(s.doc_bytes) && uint(s.doc_bytes, { allowZero: true }) === null) errs.push("snapshot doc_bytes must be a non-negative integer");
  if (!Array.isArray(s.parts)) { errs.push("snapshot parts must be an array (empty for a single-piece document)"); return errs; }
  const seen = new Set();
  s.parts.forEach((p, i) => {
    const id = p && p.id;
    if (!validId(id)) { errs.push(`snapshot part ${i + 2}: '${str(id)}' is not a node id`); return; }
    if (id === s.root || seen.has(id)) errs.push(`snapshot part ${i + 2}: '${id}' repeats`);
    seen.add(id);
    if (!REVISION_RE.test(str(p.revision))) errs.push(`snapshot part ${i + 2}: revision must be a git blob sha`);
    if (hasDigest && HEX64_RE.test(str(s.doc_sha256)) && !id.endsWith(`-g${str(s.doc_sha256).slice(0, 8)}-${i + 2}`)) {
      errs.push(`snapshot part ${i + 2}: '${id}' is not part ${i + 2} of generation ${str(s.doc_sha256).slice(0, 8)}`);
    }
  });
  return errs;
}

// ---------------------------------------------------------------------------
// Selections. JSON form:
//   {kind:"source", node, revision, doc_sha256?, start, end, quote?}
//   {kind:"image",  asset, digest, region?: {x, y, w, h}}
// Scalar URI form (one frontmatter value, no nesting):
//   spor-source:<node>@<revision>[?doc=<doc_sha256>]#utf16=<start>,<end>
//   spor-image:<asset>@sha256:<hex>[#xywh=<x>,<y>,<w>,<h>]
// Source offsets are UTF-16 code units (what a JS string, a DOM Range and
// MCP-host selection APIs count) into documentCore(...) of the exact document
// the revision names, half-open [start, end), non-empty, never splitting a
// surrogate pair. Image regions are integer pixels of the exact asset digest
// (Media Fragments xywh), within its dimensions when known.

function isHigh(c) { return c >= 0xd800 && c <= 0xdbff; }
function isLow(c) { return c >= 0xdc00 && c <= 0xdfff; }
function splitsPair(text, at) {
  return at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at));
}

// Shape errors for a selection object; with ctx it also binds the selection to
// the thing it selects:
//   source: ctx.text (the document core) and/or ctx.doc_sha256
//   image:  ctx.descriptor (an asset descriptor's frontmatter)
function validateSelection(sel, ctx = {}) {
  const s = sel || {};
  const errs = [];
  if (s.kind === "source") {
    if (!validId(s.node)) errs.push(`selection node '${str(s.node)}' is not a node id`);
    if (!REVISION_RE.test(str(s.revision))) errs.push(`selection revision '${str(s.revision)}' must be a git blob sha (40 or 64 hex)`);
    if (present(s.doc_sha256) && !HEX64_RE.test(str(s.doc_sha256))) errs.push("selection doc_sha256 must be 64 lowercase hex");
    const start = uint(s.start, { allowZero: true });
    const end = uint(s.end, { allowZero: true });
    if (start === null || end === null) { errs.push("selection start/end must be non-negative integer UTF-16 offsets"); return errs; }
    if (start >= end) errs.push(`selection range [${start}, ${end}) is empty or reversed`);
    if (s.quote != null && typeof s.quote !== "string") errs.push("selection quote must be a string");
    if (present(ctx.doc_sha256) && present(s.doc_sha256) && str(ctx.doc_sha256) !== str(s.doc_sha256)) {
      errs.push("selection doc_sha256 does not match the document");
    }
    if (ctx.text != null) {
      const text = str(ctx.text);
      if (present(s.doc_sha256) && documentDigest(text) !== str(s.doc_sha256)) errs.push("selection doc_sha256 does not match the document text");
      if (end > text.length) errs.push(`selection end ${end} is past the document (${text.length} UTF-16 units)`);
      else {
        if (splitsPair(text, start) || splitsPair(text, end)) errs.push("selection boundary splits a surrogate pair");
        if (typeof s.quote === "string" && text.slice(start, end) !== s.quote) errs.push("selection quote does not match the selected text");
      }
    }
    return errs;
  }
  if (s.kind === "image") {
    if (!validId(s.asset)) errs.push(`selection asset '${str(s.asset)}' is not a node id`);
    if (!ASSET_DIGEST_RE.test(str(s.digest))) errs.push("selection digest must be sha256:<64 lowercase hex>");
    let region = null;
    if (s.region != null) {
      const r = s.region;
      const x = uint(r.x, { allowZero: true }), y = uint(r.y, { allowZero: true }), w = uint(r.w), h = uint(r.h);
      if (x === null || y === null || w === null || h === null) errs.push("selection region needs integer x,y >= 0 and w,h >= 1");
      else region = { x, y, w, h };
    }
    if (ctx.descriptor) {
      const d = assetDescriptor(ctx.descriptor);
      if (!d) errs.push("selection asset is not a valid asset descriptor");
      else {
        if (present(s.digest) && d.digest !== str(s.digest)) errs.push("selection digest does not match the descriptor");
        if (region && (region.x + region.w > d.width || region.y + region.h > d.height)) {
          errs.push(`selection region exceeds the ${d.width}x${d.height} image`);
        }
      }
    }
    return errs;
  }
  return [`selection kind '${str(s.kind)}' is not source or image`];
}

function formatSelection(sel) {
  const errs = validateSelection(sel);
  if (errs.length) throw new Error(`formatSelection: ${errs.join("; ")}`);
  if (sel.kind === "source") {
    const doc = present(sel.doc_sha256) ? `?doc=${sel.doc_sha256}` : "";
    return `${SOURCE_SCHEME}${sel.node}@${sel.revision}${doc}#utf16=${uint(sel.start, { allowZero: true })},${uint(sel.end, { allowZero: true })}`;
  }
  const r = sel.region;
  return `${IMAGE_SCHEME}${sel.asset}@${sel.digest}${r ? `#xywh=${r.x},${r.y},${r.w},${r.h}` : ""}`;
}

const SOURCE_URI_RE = /^spor-source:([^@?#]+)@([^?#]+)(?:\?doc=([^#]*))?#utf16=([^,]*),(.*)$/;
const IMAGE_URI_RE = /^spor-image:([^@#]+)@(sha256:[^#]*)(?:#xywh=([^,]*),([^,]*),([^,]*),(.*))?$/;
// parseSelection(uri) -> {ok:true, selection} | {ok:false, error}. The parsed
// object round-trips through formatSelection byte-for-byte.
function parseSelection(uri) {
  const s = str(uri);
  let sel = null;
  let m;
  if ((m = SOURCE_URI_RE.exec(s))) {
    sel = { kind: "source", node: m[1], revision: m[2] };
    if (m[3] !== undefined) sel.doc_sha256 = m[3];
    sel.start = uint(m[4], { allowZero: true }) ?? m[4];
    sel.end = uint(m[5], { allowZero: true }) ?? m[5];
  } else if ((m = IMAGE_URI_RE.exec(s))) {
    sel = { kind: "image", asset: m[1], digest: m[2] };
    if (m[3] !== undefined) {
      sel.region = { x: uint(m[3], { allowZero: true }) ?? m[3], y: uint(m[4], { allowZero: true }) ?? m[4], w: uint(m[5]) ?? m[5], h: uint(m[6]) ?? m[6] };
    }
  } else {
    return { ok: false, error: `'${s}' is not a ${SOURCE_SCHEME} or ${IMAGE_SCHEME} selection URI` };
  }
  const errs = validateSelection(sel);
  if (errs.length) return { ok: false, error: errs.join("; ") };
  if (formatSelection(sel) !== s) return { ok: false, error: `'${s}' is not in canonical form` };
  return { ok: true, selection: sel };
}

// UTF-16 offsets -> UTF-8 byte offsets, for a reader holding bytes.
function utf8Range(text, start, end) {
  const t = str(text);
  return { start: Buffer.byteLength(t.slice(0, start), "utf8"), end: Buffer.byteLength(t.slice(0, end), "utf8") };
}

// ---------------------------------------------------------------------------
// The node-level door: every content-contract error a node's frontmatter
// carries. [] for a node with none of the keys (every legacy node). The seed
// schema-artifact validate() mirrors exactly these rules.
function validateContentFields(fm) {
  const f = fm || {};
  const errs = [];
  if (present(f.content_format) && !CONTENT_FORMATS.includes(str(f.content_format))) {
    errs.push(`content_format '${str(f.content_format)}' is not one of ${CONTENT_FORMATS.join(", ")} (omit it for a legacy body)`);
  }
  errs.push(...validateAssetDescriptor(f));
  errs.push(...validateDocumentStamps(f));
  if (present(f.selection)) {
    const p = parseSelection(f.selection);
    if (!p.ok) errs.push(`selection: ${p.error}`);
  }
  return errs;
}

module.exports = {
  CONTENT_FORMATS,
  ASSET_MEDIA_TYPES,
  ASSET_REQUIRED_KEYS,
  ASSET_KEYS,
  USES_ASSET,
  ASSET_SCHEME,
  SOURCE_SCHEME,
  IMAGE_SCHEME,
  documentCore,
  documentDigest,
  documentBytes,
  parseAssetUri,
  formatAssetUri,
  extractAssetEmbeds,
  nodeAssetEmbeds,
  reconcileAssetEdges,
  validateAssetDescriptor,
  assetDescriptor,
  validateDocumentStamps,
  validateDocumentSnapshot,
  validateSelection,
  formatSelection,
  parseSelection,
  utf8Range,
  validateContentFields,
};
