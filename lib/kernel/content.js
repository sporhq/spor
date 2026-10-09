"use strict";
// kernel/content.js — the graph-native CONTENT contracts
// (task-spor-chatgpt-content-contracts, Phase 1 of the ChatGPT workspace
// program, art-spor-chatgpt-workspace-plan-2026-10-08). Pure: data in, data
// out, no I/O. The only builtin it touches is `crypto`, for the one digest
// whose definition it owns (documentDigest), the same way kernel/gates.js
// owns definitionDigest; the only module, the pure node-file grammar
// (./frontmatter.js), which the document-generation builder edits through.
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
//   7. asset import       what an image's bytes declare (sniffImage, header
//                         only), the truncation check, the canonical
//                         descriptor text and the one safe fetch filename —
//                         ports of spor-server's upload door, the pure half of
//                         `spor asset` (lib/shell/asset.js holds the IO).
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
//   - HTML blocks whose content is never markdown (CommonMark types 1-5): a
//     line opening with `<pre>`, `<script>`, `<style>` or `<textarea>`, `<!--`,
//     `<?`, `<!X` or `<![CDATA[` runs to the line holding its closer (that
//     same line, when it closes there);
//   - blank lines end a paragraph, so no code span or image crosses one.
// Inline, within each paragraph: code spans, HTML comments and backslash
// escapes. A plain link `[x](spor-asset:…)` is a reference, not an embedding.
//   - indented (4-column) code blocks, which cannot interrupt a paragraph and
//     sit 4 columns right of their container's content (a list item's, when
//     one is open);
//   - CommonMark HTML blocks of types 6-7 (block-level tags such as `<div>`,
//     and a complete tag alone on its line — the last cannot interrupt a
//     paragraph): their lines run to the next blank line, never markdown.
// Every HTML block is container-aware: it opens only within 3 columns of its
// container's content (4+ is indented code, or paragraph text), its start and
// closer are read after the list marker / `>` markers of the container it
// opened in, and it ends with that container — never lazily continued.
// Inline constructs (code spans, comments, images) span lines only within one
// paragraph. An image destination may continue onto the paragraph's next line
// through that line's container prefix; a `>` the paragraph is not inside
// opens a new blockquote and ends it. Reference-style images are outside the
// inline-asset profile. This
// scanner is held to the renderer's shared corpus (test/fixtures/
// rich-content-corpus.json) — fence examples (GRAPH.md).
//
// Returns [{uri, id, digest, alt, start, end}] in document order, offsets in
// UTF-16 code units of `text`; a spor-asset: destination that does not parse
// comes back with `error` instead of id/digest.
const LIST_MARKER_RE = /^(?:[-*+]|[0-9]{1,9}[.)])(?:[ \t]+|$)/;
const RAW_BLOCK_RE = /^<(pre|script|style|textarea)(?=[\s>]|$)/i;
const FENCE_OPEN_RE = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^(`+|~+)[ \t]*$/;
// CommonMark HTML block start conditions 6 and 7 (1-5 are handled above/below)
const BLOCK_TAGS = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML6_RE = new RegExp(`^</?(?:${BLOCK_TAGS})(?=[\\s>]|/>|$)`, "i");
const HTML7_RE = /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/;
const HEADING_OR_RULE_RE = /^(?:#{1,6}(?:[ \t]|$)|([-*_])(?:[ \t]*\1){2,}[ \t]*$|=+[ \t]*$|-+[ \t]*$)/;

// A line's container prefix: blockquote depth, the column of its content
// (after the last `>`), whether a list marker opened on it (only read on a
// line that may OPEN a block — a continuation line's marker is content), and
// the rest of the line. At most `max` `>` markers are read as containers.
function containers(line, markers, max = Infinity) {
  // abs is the absolute column, so a tab advances to the next multiple of 4
  // (CommonMark tab stops); col counts from the content after the last `>`.
  let i = 0, abs = 0, depth = 0, col = 0, listed = false;
  for (;;) {
    let j = i;
    let w = 0;
    while (j < line.length && (line[j] === " " || line[j] === "\t")) {
      w += line[j] === "\t" ? 4 - ((abs + w) % 4) : 1;
      j++;
    }
    if (line[j] === ">" && depth < max) {
      depth++;
      i = j + 1;
      abs += w + 1;
      if (line[i] === " ") { i++; abs++; }
      col = 0;
      listed = false;
      continue;
    }
    const m = markers ? LIST_MARKER_RE.exec(line.slice(j)) : null;
    if (m) {
      let mw = 0;
      for (const ch of m[0]) mw += ch === "\t" ? 4 - ((abs + w + mw) % 4) : 1;
      col += w + mw;
      abs += w + mw;
      i = j + m[0].length;
      listed = true;
      continue;
    }
    col += w;
    return { depth, col, listed, rest: line.slice(j) };
  }
}

// The HTML block a line opens (CommonMark start conditions 1-7), or null:
// {end} is the marker that closes a raw block (1-5), or null for a block that
// runs to the next blank line (6-7); {closes} when the opening line already
// meets the end condition. Condition 7 cannot interrupt a paragraph.
function htmlStart(rest, para) {
  const lower = rest.toLowerCase();
  const raw = RAW_BLOCK_RE.exec(rest);
  let end = null, from = 0;
  if (raw) { end = `</${raw[1].toLowerCase()}>`; from = raw[0].length; }
  else if (rest.startsWith("<!--")) {
    if (/^<!---?>/.test(rest)) return { end: "-->", closes: true };
    end = "-->"; from = 4;
  } else if (rest.startsWith("<?")) { end = "?>"; from = 2; }
  else if (rest.startsWith("<![CDATA[")) { end = "]]>"; from = 9; }
  else if (/^<![A-Za-z]/.test(rest)) { end = ">"; from = 2; }
  else if (HTML6_RE.test(rest) || (!para && HTML7_RE.test(rest))) return { end: null, closes: false };
  else return null;
  return { end, closes: lower.includes(end, from) };
}

function extractAssetEmbeds(text) {
  const src = str(text);
  const out = [];
  const lines = src.split("\n");
  let pos = 0;
  let fence = null; // {ch, len, depth, col, list, content}
  let html = null; // the open HTML block: {end (raw closer, or null = runs to a blank line), depth, list}
  let inPara = false; // the previous line was paragraph text (indented code cannot interrupt it)
  let paraDepth = 0; // blockquote depth of the open paragraph
  let pid = 0; // paragraph counter: an image destination crosses a line break only within one paragraph
  const paraLines = new Map(); // line start -> {pid, skip (container prefix length)}
  let listCol = null; // content column of the open list item, if any
  let segStart = 0;
  const flush = (end) => {
    if (end > segStart) scanInline(src, segStart, end, out, paraLines);
  };
  for (const line of lines) {
    const lineEnd = pos + line.length;
    const next = Math.min(lineEnd + 1, src.length);
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    const c = containers(bare, false);
    if (fence) {
      // read the line inside the fence's own container: `>` markers past its
      // depth are content (or, left of a list item's column, a new block)
      const f = containers(bare, false, fence.depth);
      const left = f.depth < fence.depth || (fence.list && f.rest !== "" && f.col < fence.content);
      if (!left) {
        const close = FENCE_CLOSE_RE.exec(f.rest);
        if (close && close[1][0] === fence.ch && close[1].length >= fence.len &&
            f.col <= (fence.list ? fence.col + 3 : 3)) {
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
    if (html) {
      // an HTML block is never lazily continued: it ends with its container
      // (fewer `>` markers, or a non-blank line left of its list item's content)
      // (read inside its own container: `>` markers past its depth are content)
      const h = containers(bare, false, html.depth);
      const left = h.depth < html.depth || (html.list !== null && h.rest !== "" && h.col < html.list);
      if (!left) {
        if (html.end ? h.rest.toLowerCase().includes(html.end) : h.rest === "") html = null;
        segStart = next;
        pos = lineEnd + 1;
        continue;
      }
      html = null;
      segStart = pos;
    }
    if (c.rest === "") {
      flush(pos);
      segStart = next;
      inPara = false;
    } else {
      const o = containers(bare, true);
      // a deeper `>` opens a new blockquote, which interrupts the paragraph
      const para = inPara && c.depth <= paraDepth;
      if (o.listed) listCol = o.col;
      else if (listCol !== null && !para && c.col < listCol) listCol = null;
      // indentation relative to the container's content column: 4+ columns is
      // indented code (or, inside a paragraph, continuation text) — never a
      // block opener
      const deep = !o.listed && c.col - (listCol ?? 0) >= 4;
      const open = deep ? null : FENCE_OPEN_RE.exec(o.rest);
      const start = deep ? null : htmlStart(o.rest, para);
      // a block opener left of the list item's content is not a lazy line: it
      // closes the list
      if ((open || start) && !o.listed && listCol !== null && c.col < listCol) listCol = null;
      if (deep && !para) {
        // indented code: never markdown
        flush(pos);
        segStart = next;
        inPara = false;
      } else if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
        flush(pos);
        inPara = false;
        const list = o.listed || o.col >= 4;
        fence = { ch: open[1][0], len: open[1].length, depth: o.depth, col: o.col, list,
          content: o.listed ? o.col : o.col - 3 };
      } else if (start) {
        // an HTML block: its lines are raw HTML, never markdown
        flush(pos);
        segStart = next;
        inPara = false;
        if (!start.closes) html = { end: start.end, depth: o.depth, list: o.listed ? o.col : listCol };
      } else {
        // headings, thematic breaks and setext underlines are not paragraph text
        const text = !HEADING_OR_RULE_RE.test(c.rest);
        if (text) {
          if (!para || o.listed) { pid++; paraDepth = c.depth; }
          paraLines.set(pos, { pid, skip: bare.length - c.rest.length });
        }
        inPara = text;
      }
    }
    pos = lineEnd + 1;
  }
  if (!fence && !(html && html.end)) flush(src.length);
  return out;
}

// Scan [from, to) of src for inline images, honoring code spans, comments and
// escapes. Inline constructs never cross a block: a code span, comment or image
// may span lines only within one paragraph (paraLines, from the block pass), so
// a stray backtick in one block never swallows an image in the next; and never
// a fence (the caller only hands over fence-free segments).
function scanInline(src, from, to, out, paraLines) {
  let i = from;
  while (i < to) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") {
      const lim = paraEnd(src, i, to, paraLines);
      let n = 0;
      while (i + n < lim && src[i + n] === "`") n++;
      const close = findBacktickRun(src, i + n, lim, n);
      i = close === -1 ? i + n : close + n;
      continue;
    }
    if (c === "<" && src.startsWith("<!--", i)) {
      const empty = /^<!---?>/.exec(src.slice(i, i + 6));
      if (empty) { i += empty[0].length; continue; }
      const end = src.indexOf("-->", i + 4);
      i = end === -1 || end >= paraEnd(src, i, to, paraLines) ? i + 4 : end + 3;
      continue;
    }
    if (c === "!" && src[i + 1] === "[") {
      const img = parseInlineImage(src, i, paraEnd(src, i, to, paraLines), paraLines);
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
// The end (exclusive, capped at `to`) of the paragraph holding position i: the
// end of its last line. A line that is not paragraph text (a heading) is its
// own extent.
function paraEnd(src, i, to, paraLines) {
  const ls = src.lastIndexOf("\n", i - 1) + 1;
  const info = paraLines.get(ls);
  let e = src.indexOf("\n", i);
  const memo = info ? paraLines.get("end" + info.pid) : undefined;
  if (memo !== undefined) e = memo;
  else {
    let capped = false;
    while (info && e !== -1) {
      if (e >= to) { capped = true; break; }
      const nx = paraLines.get(e + 1);
      if (!nx || nx.pid !== info.pid) break;
      e = src.indexOf("\n", e + 1);
    }
    // Walk ended on the paragraph's own boundary (not the `to` cap): reuse it
    // for every later candidate in the paragraph instead of re-walking.
    if (info && !capped) paraLines.set("end" + info.pid, e);
  }
  return e === -1 || e > to ? to : e;
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
// Skip the whitespace between an image's parts. A line break is crossed only
// into the next line of the SAME paragraph, skipping that line's container
// prefix (its `>` markers): a blank line, a heading, or a line that opens a
// new block (a deeper blockquote, a list item) ends the destination.
function skipSpace(src, k, to, paraLines) {
  for (;;) {
    if (k < to && (src[k] === " " || src[k] === "\t")) { k++; continue; }
    if (k < to && src[k] === "\n") {
      const here = paraLines.get(src.lastIndexOf("\n", k - 1) + 1);
      const there = paraLines.get(k + 1);
      if (!here || !there || here.pid !== there.pid) return k;
      k = k + 1 + there.skip;
      continue;
    }
    return k;
  }
}
// `![alt](dest "title")` starting at i (src[i] === "!"). Returns {alt, dest,
// end} or null. Alt text may hold balanced brackets; the destination is
// `<…>` or a run without spaces/controls (balanced parens allowed).
function parseInlineImage(src, i, to, paraLines) {
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
  k = skipSpace(src, k, to, paraLines);
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
  k = skipSpace(src, k, to, paraLines);
  const q = src[k];
  if (q === '"' || q === "'" || q === "(") {
    const closer = q === "(" ? ")" : q;
    let t = k + 1;
    while (t < to && src[t] !== closer) t += src[t] === "\\" ? 2 : 1;
    if (t >= to) return null;
    k = t + 1;
    k = skipSpace(src, k, to, paraLines);
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
// Asset IMPORT contracts (task-spor-chatgpt-asset-cli). The pure half of `spor
// asset import|fetch|verify`: what the bytes of an image DECLARE, the canonical
// descriptor text an import writes, and the one safe filename a fetched asset
// gets. Each is a byte-for-byte port of spor-server's upload door (assets.ts
// sniffImage/checkTrailer/assetFilename, asset-uploads.ts normalizeMeta/
// descriptorText), so the same image imported locally or through POST
// /v1/assets yields the same descriptor fields — and, against a server with no
// org, the same descriptor id and text. When the server's rules move, these
// move with them.

// The server's default upload limits (assets.ts DEFAULT_LIMITS).
const ASSET_MAX_BYTES = 25 * 1024 * 1024;
const ASSET_MAX_PIXELS = 40000000;
// How far into a stream the dimension probe looks, and how many trailing
// bytes the end-of-stream structure check keeps.
const ASSET_PROBE_BYTES = 256 * 1024;
const ASSET_TAIL_BYTES = 16;
const ASSET_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const ASSET_TITLE_MAX = 200;
const ASSET_SUMMARY_MAX = 500;
const ASSET_KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegInfo(b) {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; } // standalone
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / scan before any frame header
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (JPEG_SOF.has(marker)) {
      if (i + 9 > b.length) return null;
      return { media_type: "image/jpeg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpInfo(b) {
  if (b.length < 30) return null;
  const fourcc = b.toString("latin1", 12, 16);
  if (fourcc === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { media_type: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { media_type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (fourcc === "VP8X") {
    return { media_type: "image/webp", width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

// sniffImage(head) -> {media_type, width, height} | null: the raster type and
// pixel dimensions a byte prefix declares. Header-only — it never decodes, so
// a declared pixel bomb is caught before anything inflates.
function sniffImage(b) {
  let info = null;
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString("latin1", 12, 16) === "IHDR") {
    info = { media_type: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } else if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString("latin1", 0, 6))) {
    info = { media_type: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  } else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    info = jpegInfo(b);
  } else if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    info = webpInfo(b);
  }
  if (!info || !(info.width > 0) || !(info.height > 0)) return null;
  return info;
}

// assetTrailerError(info, head, tail, size) -> null | message: the END of a
// raster stream must close the structure its header opened (a PNG's IEND, a
// GIF's 0x3B, a JPEG's EOI, a WebP RIFF length covering every byte) — the
// truncated-upload check, without decoding.
const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
function assetTrailerError(info, head, tail, size) {
  let ok = false;
  if (info.media_type === "image/png") ok = tail.length >= 12 && tail.subarray(tail.length - 12).equals(PNG_IEND);
  else if (info.media_type === "image/gif") ok = tail.length >= 1 && tail[tail.length - 1] === 0x3b;
  else if (info.media_type === "image/jpeg") ok = tail.length >= 2 && tail[tail.length - 2] === 0xff && tail[tail.length - 1] === 0xd9;
  else if (info.media_type === "image/webp") ok = head.length >= 8 && head.readUInt32LE(4) + 8 === size;
  return ok ? null : `${info.media_type} stream does not end where its structure says it should (truncated or corrupt)`;
}

// The filename a fetched asset is written under: `<descriptor id>.<ext>`,
// built only from a validated node id and the fixed extension table, so no
// title or caption can ever choose a path.
function assetFilename(id, digest, mediaType) {
  const stem = validId(id) ? id : `asset-${str(digest).slice(7, 23)}`;
  return `${stem}.${ASSET_EXTENSIONS[mediaType] || "bin"}`;
}

// One line of printable caption text, trimmed; null when empty. Throws on a
// control or line/paragraph separator (the frontmatter line parser would drop
// a line carrying one) or past `max` chars.
function assetLineText(v, field, max) {
  if (v == null || v === "") return null;
  const s = String(v);
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s)) throw new Error(`${field} must be a single line of printable text`);
  const t = s.trim();
  if (!t) return null;
  if (t.length > max) throw new Error(`${field} is over ${max} chars`);
  return t;
}

// The descriptor id an upload derives when it names none: one per (tenant,
// idempotency key), so every retry of one upload names ONE descriptor. A
// personal graph is tenant `local` (the server's own unconfigured default).
function assetDescriptorId(tenant, key) {
  return `art-asset-${crypto.createHash("sha256").update(`${tenant}\n${key}`).digest("hex").slice(0, 16)}`;
}

// normalizeAssetMeta({key, id, title, summary, alt, project, digest}, tenant)
// -> the upload metadata the descriptor is written from. Throws (message only)
// on anything the server's door would refuse with 422.
function normalizeAssetMeta(m, tenant = "local") {
  const key = str(m.key);
  if (!ASSET_KEY_RE.test(key)) throw new Error("idempotency key must be 8-200 chars of [A-Za-z0-9._:-]");
  let id = present(m.id) ? str(m.id) : null;
  if (id != null && !validId(id)) throw new Error(`bad descriptor id '${id}'`);
  if (id == null) id = assetDescriptorId(tenant, key);
  const digest = present(m.digest) ? str(m.digest) : null;
  if (digest != null && !ASSET_DIGEST_RE.test(digest)) throw new Error("digest must be sha256:<64 lowercase hex>");
  const project = present(m.project) ? str(m.project) : null;
  if (project != null && !NODE_ID_RE.test(project)) throw new Error(`bad project slug '${project}'`);
  return {
    key,
    id,
    title: assetLineText(m.title, "title", ASSET_TITLE_MAX),
    summary: assetLineText(m.summary, "summary", ASSET_SUMMARY_MAX),
    alt: assetLineText(m.alt, "alt", MAX_ALT_CHARS),
    project,
    digest,
  };
}

// assetDescriptorText(meta, asset) -> the canonical descriptor node markdown.
// `asset` is {digest, size, media_type, width, height} as the verifier
// measured it. Every caller-supplied value is JSON-quoted (a YAML double-quoted
// scalar), so no title or caption can inject a frontmatter line; the body is
// the useful TEXT a CLI/MCP read shows instead of pixels. No local path, file
// name or host detail ever reaches it.
function assetDescriptorText(meta, a) {
  const q = (s) => JSON.stringify(s);
  const label = `${a.media_type.replace(/^image\//, "").toUpperCase()} image, ${a.width}×${a.height} px, ${a.size} bytes`;
  const title = meta.title || `${label.split(",")[0]} ${a.digest.slice(7, 19)}`;
  const summary = meta.summary || `Uploaded ${label}${meta.alt ? `: ${meta.alt}` : "."}`;
  const fm = [
    "---",
    `id: ${meta.id}`,
    "type: artifact",
    `title: ${q(title)}`,
    `summary: ${q(summary)}`,
    ...(meta.project ? [`project: ${meta.project}`] : []),
    `asset_digest: ${a.digest}`,
    `asset_media_type: ${a.media_type}`,
    `asset_bytes: ${a.size}`,
    `asset_width: ${a.width}`,
    `asset_height: ${a.height}`,
    ...(meta.alt ? [`asset_alt: ${q(meta.alt)}`] : []),
    "---",
  ];
  const uri = formatAssetUri({ id: meta.id, digest: a.digest });
  const body = [
    "",
    `Asset descriptor for a ${label}. The bytes live outside graph Git, content-addressed by \`${a.digest}\`.`,
    "",
    ...(meta.alt ? [`Caption: ${meta.alt}`, ""] : []),
    `Embed it in a markdown document as \`![${meta.alt ? "caption" : "image"}](${uri})\`.`,
    "",
  ];
  return `${fm.join("\n")}\n${body.join("\n")}`;
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
// Document generations: the piece layout and the chain read
// (task-spor-chatgpt-document-cli). The server's document owner
// (spor-server docs/DOCUMENT-GENERATIONS.md, store-persist.ts
// documentGeneration / readDocument, continuation.ts generationBaseFor) is
// ported here byte-for-byte so a LOCAL graph publishes and reads a long
// document exactly as the hosted one does: the same pieces under the same
// content-addressed part ids, the same exact-body digest, the same
// completeness verdicts. Pure — the I/O half (snapshots, the root-last
// publication, the recovery journal) is lib/shell/document.js. When the
// server's builder or reader moves, this moves with it.

const fm = require("./frontmatter.js");

const DOC_BODY_CAP = 8192;
const MAX_SUMMARY_CHARS = 500;
const CONTINUATION_STAMP = "continuation_of";
const DOC_DIGEST_KEY = "doc_sha256";
const DOC_BYTES_KEY = "doc_bytes";
const DOC_GENERATION_KEY = "doc_generation";
const MAX_CONTINUATION_PARTS = 500;
const GENERATION_TAG_LEN = 8;
const PART_SUFFIX_RESERVE = String(MAX_CONTINUATION_PARTS + 1).length + 1;
const GENERATION_SUFFIX_RESERVE = 2 + GENERATION_TAG_LEN;

const SPILL_HEADER = (prevId) => `_(continued from ${prevId})_`;
const SPILL_FOOTER = (nextId) => `_(continues in ${nextId})_`;
const SPILL_FOOTER_RE = /^_\(continues in ([a-z0-9][a-z0-9-]*)\)_$/;
// Every piece is budgeted for a header AND a footer naming a max-length id.
const SPILL_OVERHEAD = Buffer.byteLength(SPILL_HEADER("x".repeat(MAX_ID_LENGTH)), "utf8") + 1 +
  1 + Buffer.byteLength(SPILL_FOOTER("x".repeat(MAX_ID_LENGTH)), "utf8");

// Which managed-document role a node's frontmatter plays: "root" (publishes a
// generation), "part" (an immutable slice of one), or null (an ordinary node,
// a legacy spill included).
function managedDocumentRole(f) {
  if (!f || typeof f !== "object") return null;
  if (f[DOC_GENERATION_KEY] != null) return "part";
  if (f[DOC_DIGEST_KEY] != null || f[DOC_BYTES_KEY] != null) return "root";
  return null;
}

// The managed-document mutation guards on an ordinary write door — the local
// twin of spor-server's reserved-fields.js doc_* durability fields plus
// write-pipeline.ts managedDocumentDenied (dec-spor-document-mutation-guards-
// at-write-chokepoint-2026-10-09). Only the document owner (put-document)
// writes a managed root's body or any stamp; every other door (put-node,
// patch, edge) runs its write through here. `priorRaw` is the stored file
// (null on create), `raw` the bytes that would land. -> {ok:true, raw} (raw
// with any OMITTED stamp restored from the prior: omission is never erasure)
// | {ok:false, message, details}.
//   * a doc_* stamp may not be asserted on create (a forged managed document)
//     nor changed on update (a stamp out of step with its body);
//   * a managed ROOT's body changes only through put-document, and its
//     continuation_of cannot change (it would re-parent the document);
//   * a generation PART is immutable: its body, its continuation_of and its
//     derived-from links (what a published revision names it by) stay as
//     published. Other metadata (title, status, edges added, …) passes.
// Bodies are compared LF-normalized, so a CRLF round-trip of an unchanged
// node passes.
const DOC_STAMP_KEYS = [DOC_DIGEST_KEY, DOC_BYTES_KEY, DOC_GENERATION_KEY];

function managedDocumentWriteGuard({ id, priorRaw = null, raw }) {
  const deny = (message, details = []) => ({ ok: false, message, details });
  const parse = (text) => {
    try {
      return fm.parseFrontmatter(text, `${id}.md`);
    } catch {
      return null;
    }
  };
  const next = parse(raw);
  if (!next) return { ok: true, raw }; // unparseable: the door's own validation reports it
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] != null;
  const ownerDoor = "only put-document sets it ('spor put-document')";
  if (priorRaw == null) {
    const forged = DOC_STAMP_KEYS.filter((k) => has(next, k));
    if (!forged.length) return { ok: true, raw };
    return deny(`'${id}' may not be created with reserved field${forged.length > 1 ? "s" : ""} '${forged.join("', '")}'`,
      forged.map((k) => `${k}: ${ownerDoor}`));
  }
  const cur = parse(priorRaw);
  if (!cur) return { ok: true, raw };
  const changed = DOC_STAMP_KEYS.filter((k) => has(next, k) && String(next[k]) !== String(cur[k] ?? ""));
  if (changed.length) {
    return deny(`'${id}': reserved field${changed.length > 1 ? "s" : ""} '${changed.join("', '")}' cannot change`,
      changed.map((k) => `${k}: ${ownerDoor}`));
  }
  let out = raw;
  for (const k of DOC_STAMP_KEYS) {
    if (!has(next, k) && has(cur, k)) out = fm.withKey(out, k, String(cur[k])) ?? out;
  }
  const role = managedDocumentRole(cur);
  if (!role) return { ok: true, raw: out };
  const after = (out !== raw && parse(out)) || next;
  const before = fm.splitDocument(priorRaw);
  const now = fm.splitDocument(out);
  // `spor get <id>` prints one extra trailing newline, so a get -> edit ->
  // put-node round trip differs from the stored body by trailing newlines
  // alone. That is not a body change: the stored tail is restored.
  const trimNl = (t) => t.replace(/\n+$/, "");
  if (before && now && before.body !== now.body && trimNl(before.body) === trimNl(now.body)) {
    out = out.slice(0, out.length - now.bodyRaw.length) + before.bodyRaw;
    now.body = before.body;
  }
  const bodyChanged = !before || !now || before.body !== now.body;
  const host = String(cur[CONTINUATION_STAMP] ?? "");
  if (role === "root") {
    if (String(after[CONTINUATION_STAMP] ?? "") !== host) {
      return deny(`'${id}' is a managed document root; its ${CONTINUATION_STAMP} cannot change`,
        [`a ${CONTINUATION_STAMP} stamp would re-parent the document into another node's continuation chain`]);
    }
    if (!bodyChanged) return { ok: true, raw: out };
    return deny(`'${id}' is a managed document; its body changes only through put-document`, [
      `read the whole document with 'spor get ${id} --document --json > read.json' and publish the edited source with 'spor put-document <file> --snapshot read.json' — that republishes a generation and keeps every published revision readable`,
      "metadata-only edits (title, summary, edges, status, …) through this door are fine; leave the body as stored",
    ]);
  }
  const immutable = (what) => deny(`'${id}' is an immutable generation part${host ? ` of '${host}'` : ""}; ${what}`,
    [`edit the document through its root: 'spor get ${host || "<root>"} --document' then 'spor put-document' publishes a new generation, and this part stays as the published revisions name it`]);
  if (bodyChanged) return immutable("its body cannot change");
  if (String(after[CONTINUATION_STAMP] ?? "") !== host) return immutable(`its ${CONTINUATION_STAMP} cannot change`);
  const links = (f) => new Set((Array.isArray(f.edges) ? f.edges : []).filter((e) => e && e.type === "derived-from").map((e) => String(e.to)));
  const kept = links(after);
  const dropped = [...links(cur)].filter((to) => !kept.has(to));
  if (dropped.length) return immutable(`its derived-from link${dropped.length > 1 ? "s" : ""} to '${dropped.join("', '")}' cannot be removed`);
  return { ok: true, raw: out };
}

// Cut `text` into slices of at most `cap` UTF-8 bytes whose concatenation is
// `text`: the last paragraph break that fits, then the last line break, then
// the last code-point boundary — never inside a character.
function spillChunks(text, cap) {
  const out = [];
  let rest = text;
  while (Buffer.byteLength(rest, "utf8") > cap) {
    let fit = 0;
    let bytes = 0;
    for (const ch of rest) {
      const b = Buffer.byteLength(ch, "utf8");
      if (bytes + b > cap) break;
      bytes += b;
      fit += ch.length;
    }
    const window = rest.slice(0, fit);
    const para = window.lastIndexOf("\n\n");
    const line = window.lastIndexOf("\n");
    let cut = para > 0 ? para + 2 : line > 0 ? line + 1 : fit;
    while (cut < fit && rest[cut] === "\n") cut++;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

// The inverse of the piece layout: stored bodies, in order, back to the one
// body they were cut from (canonical form: one wrapping newline each side).
function spillReassemble(bodies) {
  const strip = (b) => b.replace(/^\n/, "").replace(/\n$/, "");
  const core = bodies.map((b, i) => {
    let t = strip(b);
    if (i > 0) t = t.slice(t.indexOf("\n") + 1);
    if (i < bodies.length - 1) t = t.slice(0, t.lastIndexOf("\n"));
    return t;
  }).join("");
  return `\n${core}\n`;
}

// A base too long for `<base>-<n>` to fit is cut and suffixed with a digest
// of the whole base (continuation.ts fitBase).
function fitBase(base, extra = 0) {
  const room = MAX_ID_LENGTH - PART_SUFFIX_RESERVE - extra;
  if (base.length <= room) return base;
  const digest = crypto.createHash("sha256").update(base, "utf8").digest("hex").slice(0, 10);
  return `${base.slice(0, room - digest.length - 1).replace(/-+$/, "")}-${digest}`;
}

// `<family base>-g<tag>`: the host's continuation family (`art-<stem>` for an
// artifact, `art-<type>-<stem>` otherwise — the LONGEST declared prefix is
// stripped), fitted with room for the tag. `prefixes` are the registry's
// declared id prefixes for `type`.
function generationBaseFor(id, type, digest, prefixes = []) {
  const tag = str(digest).slice(0, GENERATION_TAG_LEN);
  if (!/^[0-9a-f]{8}$/.test(tag)) throw new Error(`generationBaseFor: '${digest}' is not a hex digest`);
  const matched = [...(prefixes || [])].sort((a, b) => b.length - a.length)
    .find((p) => id.startsWith(p) && id.length > p.length);
  const stem = matched ? id.slice(matched.length) : id;
  const base = `art-${matched && type && type !== "artifact" ? `${type}-${stem}` : stem}`;
  return `${fitBase(base, GENERATION_SUFFIX_RESERVE)}-g${tag}`;
}

const sanitizeScalar = (s) => str(s).replace(/[\r\n]+/g, " ").replace(/[[\]]/g, "").trim();

// Set one flat key the way the server's setFmLine does: in place when it
// exists, else appended after the frontmatter with its trailing blank lines
// dropped (`${fm.replace(/\n+$/, "")}\n${line}`).
function setKeyLine(raw, key, value) {
  const doc = fm.splitDocument(raw);
  if (fm.lexFrontmatter(doc.frontmatter, "node.md", { lenient: true }).entries.some((e) => e.key === key && e.kind !== "edges")) {
    return fm.withKey(raw, key, value);
  }
  return fm.joinDocument({ ...doc, frontmatter: `${doc.frontmatter.replace(/\n+$/, "")}\n${key}: ${value}` });
}

// Build one generation of a document source (frontmatter + a body of any
// length): the root's new text and every part's text, under content-addressed
// ids. -> {ok:true, id, type, digest, bytes, root, parts:[{id, raw}]} |
// {ok:false, code, message, details}. `prefixes` are the registry's id
// prefixes for the root's type; `today` (YYYY-MM-DD) dates the parts when the
// root carries no date.
function documentGeneration(raw, { prefixes = [], today = new Date().toISOString().slice(0, 10) } = {}) {
  let parsed;
  try {
    parsed = fm.parseFrontmatter(raw, "incoming.md");
  } catch (e) {
    return { ok: false, code: "invalid_node", message: `unparseable node: ${str(e && e.message).slice(0, 200)}`, details: [] };
  }
  const doc0 = fm.splitDocument(raw);
  if (!parsed || !parsed.id || !doc0) return { ok: false, code: "invalid_node", message: "a document root needs an id and a body", details: [] };
  const id = String(parsed.id);
  const partStamps = [DOC_GENERATION_KEY, CONTINUATION_STAMP].filter((k) => parsed[k] != null);
  if (partStamps.length) {
    return {
      ok: false, code: "invalid_node", id,
      message: `a document root may not carry ${partStamps.join(" or ")} — those mark a continuation part`,
      details: ["remove the field from the source; the publisher stamps each part itself"],
    };
  }
  const core = documentCore(doc0.body);
  const bytes = documentBytes(core);
  const digest = documentDigest(core);
  const chunks = bytes <= DOC_BODY_CAP ? [core] : spillChunks(core, DOC_BODY_CAP - SPILL_OVERHEAD);
  if (chunks.length > MAX_CONTINUATION_PARTS) {
    return { ok: false, code: "invalid_node", id, message: `document needs ${chunks.length} pieces; a generation holds at most ${MAX_CONTINUATION_PARTS}`, details: [] };
  }
  const base = generationBaseFor(id, parsed.type, digest, prefixes);
  const ids = chunks.map((_, i) => (i ? `${base}-${i + 1}` : id));
  const day = /^\d{4}-\d{2}-\d{2}$/.test(str(parsed.date)) ? str(parsed.date) : today;
  const text = (i) => `${i ? `${SPILL_HEADER(ids[i - 1])}\n` : ""}${chunks[i]}${i < chunks.length - 1 ? `\n${SPILL_FOOTER(ids[i + 1])}` : ""}`;
  let stamped = fm.withKey(fm.withKey(raw, "spill_sha256", null), "spill_bytes", null);
  stamped = setKeyLine(setKeyLine(stamped, DOC_DIGEST_KEY, digest), DOC_BYTES_KEY, bytes);
  const doc = fm.splitDocument(stamped);
  const root = fm.joinDocument({ frontmatter: doc.frontmatter, body: `\n${text(0)}\n`, crlf: doc.crlf });
  const hostTitle = sanitizeScalar(parsed.title || id).slice(0, 160);
  const parts = ids.slice(1).map((pid, k) => {
    const i = k + 1;
    const prevId = ids[i - 1];
    const summary = `Part ${i + 1} of generation ${digest.slice(0, 8)} of ${id}: an immutable slice of one exact ` +
      `revision of that document. Read it through ${id}, never on its own.`;
    const lines = ["---", `id: ${pid}`, "type: artifact"];
    if (parsed.project && NODE_ID_RE.test(parsed.project)) lines.push(`repo: ${parsed.project}`);
    lines.push(
      `title: ${hostTitle} — continuation ${i + 1}`,
      `summary: ${sanitizeScalar(summary).slice(0, MAX_SUMMARY_CHARS)}`,
      "status: active",
      `date: ${day}`,
      `${CONTINUATION_STAMP}: ${id}`,
      `${DOC_GENERATION_KEY}: ${digest}`,
      "edges:",
      `  - {type: derived-from, to: ${prevId}}`,
    );
    if (prevId !== id) lines.push(`  - {type: derived-from, to: ${id}}`);
    lines.push("---", "");
    return { id: pid, raw: `${lines.join("\n")}\n${text(i)}\n` };
  });
  return { ok: true, id, type: parsed.type, digest, bytes, root, parts };
}

// Walk a root's footer chain into its parts and rejoin the body
// (store-persist.ts readDocument). `root` is {raw, frontmatter}; `getNode(id)`
// returns a part's CURRENT {raw, frontmatter} or null; `pinned` says the root
// was read at an explicit revision. -> {body, parts, complete, generation?,
// missing?, integrity_failed?, history_unavailable?}.
//   * a generation root follows only parts stamped as slices of ITS
//     generation — anything else under that id reads as missing;
//   * a PINNED read of a legacy root whose footer names a part answers its own
//     piece only (history_unavailable): legacy parts are mutable;
//   * a generation root is held to the EXACT body (doc_sha256/doc_bytes), a
//     legacy spill_sha256 stamp to the prefix.
function readDocumentChain(root, getNode, { pinned = false } = {}) {
  const doc = fm.splitDocument(root.raw);
  if (!doc) return null;
  const stamp = root.frontmatter || {};
  const managed = managedDocumentRole(stamp) === "root";
  const id = str(stamp.id);
  const ids = [id];
  const bodies = [doc.body];
  const lines = (b) => b.replace(/^\n/, "").replace(/\n$/, "").split("\n");
  for (;;) {
    const prev = lines(bodies[bodies.length - 1]);
    const m = SPILL_FOOTER_RE.exec(prev[prev.length - 1]);
    if (!m) break;
    const next = m[1];
    if (pinned && !managed) {
      return { body: spillReassemble(bodies), parts: [], complete: false, missing: next, history_unavailable: true };
    }
    const part = ids.includes(next) ? null : getNode(next);
    const pdoc = part && fm.splitDocument(part.raw);
    const pfm = (part && part.frontmatter) || {};
    const foreign = managed &&
      (str(pfm[DOC_GENERATION_KEY]) !== str(stamp[DOC_DIGEST_KEY]) || str(pfm[CONTINUATION_STAMP]) !== id);
    if (!pdoc || foreign || lines(pdoc.body)[0] !== SPILL_HEADER(ids[ids.length - 1])) {
      return {
        body: spillReassemble(bodies), parts: ids.slice(1), complete: false,
        ...(managed ? { generation: str(stamp[DOC_DIGEST_KEY]) } : {}), missing: next,
      };
    }
    ids.push(next);
    bodies.push(pdoc.body);
  }
  const body = spillReassemble(bodies);
  if (stamp[DOC_DIGEST_KEY] != null || stamp[DOC_BYTES_KEY] != null) {
    const core = body.slice(1, -1);
    const exact = str(stamp[DOC_BYTES_KEY]) === String(documentBytes(core)) && str(stamp[DOC_DIGEST_KEY]) === documentDigest(core);
    const gen = { generation: str(stamp[DOC_DIGEST_KEY]) };
    return exact
      ? { body, parts: ids.slice(1), complete: true, ...gen }
      : { body, parts: ids.slice(1), complete: false, ...gen, integrity_failed: true };
  }
  if (stamp.spill_sha256 != null || stamp.spill_bytes != null) {
    const bytes = Buffer.from(body.slice(1, -1), "utf8");
    const n = Number(stamp.spill_bytes);
    if (!Number.isInteger(n) || bytes.length < n || str(stamp.spill_sha256) !== documentDigest(bytes.subarray(0, n).toString("utf8"))) {
      return { body, parts: ids.slice(1), complete: false, integrity_failed: true };
    }
  }
  return { body, parts: ids.slice(1), complete: true };
}

// The get_document answer (documents.ts getDocument) from a root as read, its
// chain read, and the snapshot that pins it.
function documentAnswer(root, doc, snapshot) {
  const split = fm.splitDocument(root.raw);
  const source = fm.joinDocument({ frontmatter: split.frontmatter, body: doc.body, crlf: split.crlf });
  const core = documentCore(doc.body);
  return {
    id: snapshot.root,
    revision: root.revision,
    source,
    body: doc.body,
    complete: doc.complete,
    managed: managedDocumentRole(root.frontmatter) === "root",
    ...(doc.complete ? { doc_sha256: documentDigest(core), doc_bytes: documentBytes(core) } : {}),
    ...(doc.generation ? { generation: doc.generation } : {}),
    parts: snapshot.parts,
    snapshot,
    ...(doc.missing ? { missing: doc.missing } : {}),
    ...(doc.integrity_failed ? { integrity_failed: true } : {}),
  };
}

// The one status line a text reader gets ahead of the source (documents.ts
// documentText), and the one line a publication reports (publicationText).
function documentStateLine(d) {
  const state = d.complete
    ? `${d.parts.length ? `${d.parts.length + 1} pieces` : "one piece"}, complete`
    : d.integrity_failed
      ? "INCOMPLETE — the reassembled text does not match the document's digest"
      : `INCOMPLETE — continuation ${d.missing} could not be followed`;
  return `Document ${d.id} @ ${d.revision} (${state})`;
}
function publicationLine(r) {
  const parts = r.parts && r.parts.length ? ` (+ generation parts ${r.parts.join(", ")})` : "";
  return `put-document ${r.status}: ${r.id} @ ${r.revision}, generation ${str(r.generation).slice(0, 8)}${parts}`;
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
  ASSET_MAX_BYTES,
  ASSET_MAX_PIXELS,
  ASSET_PROBE_BYTES,
  ASSET_TAIL_BYTES,
  ASSET_EXTENSIONS,
  sniffImage,
  assetTrailerError,
  assetFilename,
  assetDescriptorId,
  normalizeAssetMeta,
  assetDescriptorText,
  DOC_BODY_CAP,
  DOC_DIGEST_KEY,
  DOC_BYTES_KEY,
  DOC_GENERATION_KEY,
  CONTINUATION_STAMP,
  MAX_CONTINUATION_PARTS,
  managedDocumentRole,
  managedDocumentWriteGuard,
  DOC_STAMP_KEYS,
  spillChunks,
  spillReassemble,
  generationBaseFor,
  documentGeneration,
  readDocumentChain,
  documentAnswer,
  documentStateLine,
  publicationLine,
};
