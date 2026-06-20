// kernel/timestamps.js — pure git-derived timestamp folding (dec-spor-git-
// derived-timestamps, task-spor-git-derived-timestamp-index). Data in, data
// out (REFACTOR.md §1): no filesystem, no git spawn, no environment. The shell
// half (lib/shell/gittime.js) runs `git log` and reads/writes the cache; this
// module only PARSES that log text, MERGES an incremental range into a base, and
// applies the frontmatter override seam. The fold lives in the kernel so the
// server (which forward-maintains the same index per write) and the client share
// ONE implementation — the kernel is the single source of truth, like the
// registry. Plain Node, zero deps.
//
// Exports:
//   foldGitTimestamps(logText, nodesName)     -> { id: { created_at, updated_at } }
//   mergeTimestampMaps(base, add)             -> merged map (min created / max updated)
//   mergeTimestampOverrides(gitTs, nodes)     -> map with frontmatter override applied
//   coldInHotNeighborhood(graph, id, ts)      -> count of strictly-newer neighbors

"use strict";

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isoOf = (ms) => new Date(ms).toISOString();
const parse = (iso) => (iso ? Date.parse(iso) : NaN);

// Parse `git log --name-only --diff-filter=ACMR --format=%ct -- <nodesName>/`
// output into { id: { created_at, updated_at } } (ISO-8601 UTC strings).
//
// git emits newest-commit-first; each block is one numeric epoch-seconds line, a
// blank line, then the node files that commit touched:
//   1769904000
//
//   nodes/dec-b.md
//   nodes/task-a.md
//   1767225600
//   ...
// A purely-numeric line is a commit time — it can never be a `<nodesName>/…md`
// path, so the two are unambiguous without a sentinel. created_at = the OLDEST
// commit touching a node file, updated_at = the NEWEST; folded as min/max so the
// result is independent of emit order AND an incremental range fold composes via
// mergeTimestampMaps. Pure deletes are excluded upstream (--diff-filter=ACMR),
// matching gitFront's "a removed node isn't live work".
function foldGitTimestamps(logText, nodesName = "nodes") {
  const acc = {};
  if (!logText) return {};
  const fileRe = new RegExp(`^${reEsc(nodesName)}/([a-z0-9][a-z0-9-]*)\\.md$`);
  let t = null;
  for (const raw of logText.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\d+$/.test(line)) { t = Number(line) * 1000; continue; }
    if (t == null) continue;
    const m = fileRe.exec(line);
    if (!m) continue;
    const id = m[1];
    const cur = acc[id];
    if (!cur) acc[id] = { min: t, max: t };
    else { if (t < cur.min) cur.min = t; if (t > cur.max) cur.max = t; }
  }
  const out = {};
  for (const id of Object.keys(acc)) out[id] = { created_at: isoOf(acc[id].min), updated_at: isoOf(acc[id].max) };
  return out;
}

// Compose an incremental range fold (`add`, from OLD..NEW) onto the cached base:
// created_at keeps the EARLIER, updated_at takes the LATER, and a node seen only
// in the range is added whole. The base already holds each node's full-history
// extents, and the range commits are strictly newer than the cached HEAD, so in
// practice `add` only advances updated_at (or introduces a brand-new node) — but
// the min/max keeps it correct even if a caller folds an overlapping range.
function mergeTimestampMaps(base, add) {
  const out = { ...base };
  for (const id of Object.keys(add)) {
    const a = add[id], b = out[id];
    if (!b) { out[id] = { ...a }; continue; }
    const cb = parse(b.created_at), ca = parse(a.created_at);
    const ub = parse(b.updated_at), ua = parse(a.updated_at);
    out[id] = {
      created_at: ca < cb ? a.created_at : b.created_at,
      updated_at: ua > ub ? a.updated_at : b.updated_at,
    };
  }
  return out;
}

// Apply the explicit-frontmatter override seam (dec-spor-git-derived-timestamps)
// over the live node bytes, producing the index every consumer reads. Precedence
// per field, high-first:
//   1. explicit frontmatter `created_at` / `updated_at` — the system override, an
//      immutable pin for graphs where git history is lossy (squash/rebase, the
//      graph-inside-code-repo PR flow);
//   2. the git-derived value;
//   3. `.date` — the LAST-RESORT fallback when git has nothing for the node (an
//      uncommitted node, or one a squash erased).
// `.date` (semantic, author-assignable) stays DISTINCT from created_at (system):
// a node with valid git history keeps its git created_at even when it carries a
// .date — .date only fills a hole, it never overrides a real git extent. A node
// with no git entry and no usable frontmatter is omitted (no derivable time).
function mergeTimestampOverrides(gitTs, nodes) {
  const out = {};
  for (const n of Object.values(nodes)) {
    const g = gitTs[n.id];
    const created = n.created_at || (g && g.created_at) || n.date || null;
    const updated = n.updated_at || (g && g.updated_at) || n.date || null;
    if (created || updated) out[n.id] = { created_at: created, updated_at: updated };
  }
  return out;
}

// "cold node, hot neighborhood" (task-spor-git-derived-timestamp-index): the
// count of this node's traversable neighbors whose updated_at is STRICTLY newer
// than the node's own — a node that went cold while its neighborhood kept moving.
// Pure over graph.adj + the injected timestamp index. Returns 0 when there is no
// index, the node has no parseable updated_at, or no neighbor is newer — so a
// graph WITHOUT the index (the kernel buildGraph path, conformance, the prompt
// path) contributes nothing and is byte-identical.
function coldInHotNeighborhood(graph, nodeId, timestamps) {
  if (!timestamps) return 0;
  const self = timestamps[nodeId];
  const selfT = self ? parse(self.updated_at) : NaN;
  if (Number.isNaN(selfT)) return 0;
  let newer = 0;
  for (const e of graph.adj[nodeId] ?? []) {
    const nb = timestamps[e.to];
    const t = nb ? parse(nb.updated_at) : NaN;
    if (!Number.isNaN(t) && t > selfT) newer++;
  }
  return newer;
}

module.exports = { foldGitTimestamps, mergeTimestampMaps, mergeTimestampOverrides, coldInHotNeighborhood };
