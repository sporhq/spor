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
function couplingHit(norm, { slug, relPath, repoTags }) {
  for (const entry of arr(norm.couples_when)) {
    const { repo, glob } = parseEntry(entry);
    if (repo !== null) {
      if (repoMatches(repo, slug) && globToRegExp(glob).test(relPath)) return true;
    } else if (scopeOk(norm, slug, repoTags) && globToRegExp(glob).test(relPath)) {
      return true;
    }
  }
  return false;
}

// All coupling norms in `norms` whose triggers hit — the one call the nudge
// (and later `spor check`) makes. `norms` are plain parsed node objects.
function matchCouplings(norms, ctx) {
  return arr(norms).filter((n) => isCouplingNorm(n) && couplingHit(n, ctx));
}

module.exports = { parseEntry, globToRegExp, isCouplingNorm, scopeOk, couplingHit, matchCouplings, TERMINAL };
