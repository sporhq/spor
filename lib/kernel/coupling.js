"use strict";
// coupling.js — the pure coupled-artifact matcher
// (dec-spor-coupling-norms-declared-first, task-spor-coupling-nudge-posttool).
//
// A COUPLING NORM is an ordinary `type: norm` node carrying two flat inline
// lists: `couples_when:` (trigger file globs — "when files matching these
// change") and `couples_also:` (the coupled targets that should change in the
// same edit, or be consciously dismissed). Both keys are required for the norm
// to participate; either alone is inert (validateGraphFiles warns).
//
// Entries are repo-root-relative globs, optionally REPO-QUALIFIED as
// `<slug>:<glob>` (or `repo-<slug>:<glob>`) so one norm can couple artifacts
// ACROSS repos — e.g. a norm stamped `project: spor` may declare
// `couples_when: [spor-docs:src/content/**]` and fire in spor-docs sessions:
//   - a QUALIFIED trigger matches only in that repo and BYPASSES the norm's
//     scope (the explicit pin is the scope);
//   - an UNQUALIFIED trigger applies wherever the norm itself applies — its
//     `applies_to_*` selectors when declared, else its `project:` stamp
//     (unstamped = every repo, the org-wide case: `couples_when: [.nvmrc]`,
//     `couples_also: [Dockerfile]`).
// Targets in `couples_also` are display strings for the consumer (the nudge
// names them; `spor check` will match them) and may be qualified the same way.
//
// Scope here is the ENGINE-SIDE approximation of the compile ride-along
// (task-cc-norm-ride-along-repo-tag-scope): `applies_to_repos` matches the
// session slug (bare or `repo-` id), `applies_to_tags` intersects the session
// repo node's `tags`, and `applies_to_projects` is a DIRECT id/slug compare —
// no grouping-union expansion (that needs the loaded graph; the consumers of
// this module run in the hook tool loop without one). Same OR-across-axes,
// strict-exclude-on-declared-no-match semantics.
//
// Glob dialect (deliberately small, documented in GRAPH.md): `**` crosses
// path segments, `*` matches within one segment, `?` one character; a
// trailing `/` means the whole subtree (`skills/spor/` ≡ `skills/spor/**`).
// No brace or bracket classes — entries live inside the regex frontmatter's
// inline-list `[...]` grammar, so a literal `]` can never round-trip anyway.
// Matching is against the repo-root-relative path, forward slashes, and a
// bare `API.md` matches only at the root (use `**/AGENTS.md` for any depth).

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const arr = (v) => (Array.isArray(v) ? v : []);

// Statuses that retire a coupling norm from matching (norms rarely carry a
// status at all; an absent status is live).
const TERMINAL = new Set(["done", "resolved", "rejected", "retired", "superseded", "dismissed", "deprecated", "closed"]);

// `<slug>:<glob>` → { repo, glob }; unqualified → { repo: null, glob }.
function parseEntry(entry) {
  const s = String(entry ?? "").trim();
  const i = s.indexOf(":");
  if (i > 0 && SLUG_RE.test(s.slice(0, i)) && s.slice(i + 1) !== "") {
    return { repo: s.slice(0, i), glob: s.slice(i + 1) };
  }
  return { repo: null, glob: s };
}

// A qualifier written as the repo NODE id (`repo-spor`) matches the bare slug.
function repoMatches(qualifier, slug) {
  return qualifier === slug || String(qualifier).replace(/^repo-/, "") === slug;
}

function globToRegExp(glob) {
  let g = String(glob);
  if (g.endsWith("/")) g += "**"; // trailing slash = whole subtree
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") { re += "(?:[^/]+/)*"; i += 2; } // `**/` = zero or more segments
        else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// Is this parsed node a live coupling norm? (type norm, both keys as
// non-empty lists — the regex parser stores a malformed scalar as a string,
// which arr() treats as absent, mirroring the applies_to_* fail-safe.)
function isCouplingNorm(n) {
  if (!n || n.type !== "norm") return false;
  if (n.status && TERMINAL.has(String(n.status))) return false;
  return arr(n.couples_when).length > 0 && arr(n.couples_also).length > 0;
}

// The engine-side norm scope for UNQUALIFIED triggers (see header).
function scopeOk(norm, slug, repoTags = []) {
  const declared =
    arr(norm.applies_to_tags).length || arr(norm.applies_to_repos).length || arr(norm.applies_to_projects).length;
  if (!declared) return !norm.project || norm.project === slug;
  const tags = new Set(arr(repoTags));
  return (
    arr(norm.applies_to_tags).some((t) => tags.has(t)) ||
    arr(norm.applies_to_repos).some((r) => repoMatches(r, slug)) ||
    arr(norm.applies_to_projects).some((p) => p === slug || String(p).replace(/^proj-/, "") === slug)
  );
}

// Does one coupling norm's trigger set hit this (slug, repo-relative path)?
// `relPath` is usually a single spelling, but a caller may pass an ARRAY of
// candidate spellings when the edited file has more than one valid
// repo-relative path — an in-repo symlinked subtree has both the alias
// spelling and the git-resolved spelling, and literal-first path derivation
// (toRepoRel/repoRelativeCandidates in scripts/engines/util.js) only ever
// hands back one of them at a time. A glob authored against EITHER spelling
// still counts as a hit here (task-spor-coupling-matcher-symlink-alias).
function couplingHit(norm, { slug, relPath, repoTags }) {
  const paths = Array.isArray(relPath) ? relPath : [relPath];
  const matches = (glob) => {
    const re = globToRegExp(glob);
    return paths.some((p) => re.test(p));
  };
  for (const entry of arr(norm.couples_when)) {
    const { repo, glob } = parseEntry(entry);
    if (repo !== null) {
      if (repoMatches(repo, slug) && matches(glob)) return true;
    } else if (scopeOk(norm, slug, repoTags) && matches(glob)) {
      return true;
    }
  }
  return false;
}

// All coupling norms in `norms` whose triggers hit — the one call the nudge
// (and `spor check`) makes. `norms` are plain parsed node objects.
function matchCouplings(norms, ctx) {
  return arr(norms).filter((n) => isCouplingNorm(n) && couplingHit(n, ctx));
}

// ---------- the shared norm snapshot scan ----------

// The fields a consumer needs from a coupling norm (the nudge caches these as
// its snapshot; `spor check` reads them fresh). couples_value_a/b are the
// OPTIONAL value invariant (see parseValueSpec below).
const COUPLING_FIELDS = [
  "id", "type", "title", "project", "status",
  "couples_when", "couples_also", "couples_value_a", "couples_value_b",
  "applies_to_tags", "applies_to_repos", "applies_to_projects",
];
function slimCouplingNorm(n) {
  const out = {};
  for (const k of COUPLING_FIELDS) if (n[k] != null) out[k] = n[k];
  return out;
}

// Scan node files (any source — a local nodes dir, an extracted export) for
// coupling norms + repo tags. `read(name)` returns a file's raw text (or
// null/throws to skip); the cheap substring prefilter keeps the parse cost to
// coupling norms and repo nodes only. Shared by the post-tool nudge and the
// `spor check` verb so the two consumers can never drift on what a coupling
// norm IS.
function scanCouplingEntries(read, names) {
  const { parseFrontmatter } = require("./graph.js"); // lazy: keep the no-coupling fast path lean
  const basename = (f) => f.split("/").pop();
  const norms = [];
  const repo_tags = {};
  for (const f of names) {
    if (!f.endsWith(".md")) continue;
    const isRepoNode = basename(f).startsWith("repo-");
    let raw;
    try {
      raw = read(f);
    } catch {
      continue;
    }
    if (raw == null) continue;
    if (!isRepoNode && !raw.includes("couples_when:")) continue;
    let n;
    try {
      n = parseFrontmatter(raw, f);
    } catch {
      continue;
    }
    if (n.type === "repo") {
      if (Array.isArray(n.tags)) {
        const slug = String(n.id ?? basename(f).slice(0, -3)).replace(/^repo-/, "");
        repo_tags[slug] = n.tags;
      }
      continue;
    }
    if (isCouplingNorm(n)) norms.push(slimCouplingNorm(n));
  }
  return { norms, repo_tags };
}

// ---------- value invariants (spor check, task-spor-cli-check-coupling-verb) ----------

// A coupling norm may declare a machine-checkable VALUE invariant — two flat
// scalar keys naming a file and an extraction pattern each, whose extracted
// values must agree:
//
//   couples_value_a: .nvmrc#(\d+)
//   couples_value_b: Dockerfile#FROM node:(\d+)
//
// Spec grammar: `<path>#<regex>` split on the FIRST `#`; the regex's first
// capture group (or the whole match) is the value. The path may be
// repo-qualified like any coupling entry — a side pinned to a different repo
// than the session's is unverifiable there and the checker skips it with a
// note. Scalars, not lists, so the regex may carry commas/brackets freely.
function parseValueSpec(spec) {
  const s = String(spec ?? "").trim();
  const i = s.indexOf("#");
  if (i <= 0 || i === s.length - 1) return null; // no file or no pattern
  const { repo, glob } = parseEntry(s.slice(0, i));
  return { repo, file: glob, pattern: s.slice(i + 1) };
}

// Extract the invariant value from a file's content: first capture group of
// the first (multiline) match, else the whole match; null when the pattern
// misses or doesn't compile.
function extractValue(content, patternSrc) {
  let re;
  try {
    re = new RegExp(patternSrc, "m");
  } catch {
    return null;
  }
  const m = re.exec(String(content ?? ""));
  if (!m) return null;
  return m[1] ?? m[0];
}

module.exports = {
  parseEntry, globToRegExp, isCouplingNorm, scopeOk, couplingHit, matchCouplings, TERMINAL,
  COUPLING_FIELDS, slimCouplingNorm, scanCouplingEntries, parseValueSpec, extractValue, repoMatches,
};
