#!/usr/bin/env node
// commit-inference.js — infer commit→node links for UNTRAILERED commits
// (task-cc-commit-inference). The trailer path (task-cc-commit-linking) is an
// explicit declaration and stamps directly; everything here is a guess, and a
// wrong commit link is worse than a missing one — the blame-a-line-get-the-why
// consumer trusts the graph's answer, while a missing link just degrades to
// reading the commit message.
//
// So this module is ONLY the high-precision GATE. It never writes the graph:
// given a commit's client-side evidence (sha, branch, message, diff files —
// none of which the server ever sees) and the candidate nodes' id+title
// (+ body when available), it scores each (commit, node) pair and emits the
// confident pairs as *proposals* carrying the signals that fired. The
// distiller hands those proposals to POST /v1/capture as plain-prose evidence,
// where the existing ingestion model proposes the sha link as a reviewable
// capture (authored_via: capture). Evidence INTO the ingestion decision, never
// a stamp.
//
// Precision stance — false links are worse than missed links. Three signals,
// ranked by how forgeable they are:
//   1. branch-name ↔ node-id   (STRONG)   — the branch literally names the work
//   2. file-path  ↔ node-referenced artifact (STRONG) — touched a file the node cites
//   3. message    ↔ node-title overlap     (WEAK)     — corroborates, never decides alone
// The weak signal is capped below threshold so it can only ever tip a pair
// that already has independent corroboration. Parallel sessions on one branch
// (shared barrel files, lockfiles) are exactly where file-overlap gets murky,
// so basename-only file matches are denylisted for common shared files and
// only verbatim path matches carry full weight.
//
// The threshold is explicit and configurable: opts.threshold, else
// DEFAULT_THRESHOLD ($SPOR_INFER_THRESHOLD is applied by the
// lib/commit-inference.js façade, which also carries the stdin/stdout CLI).

"use strict";

const DEFAULT_THRESHOLD = 0.7;

// Weight caps per signal. The weak (message) signal is capped strictly below
// the default threshold so it can never cross the line on its own.
const W_BRANCH_EXACT_ID = 1.0; // branch segment IS the full node id
const W_BRANCH_ID_TAIL = 0.9; // branch segment is the id minus its type/project prefix
const W_FILE_PATH = 0.8; // commit touches a path the node cites verbatim
const W_FILE_BASENAME = 0.5; // commit touches a file whose basename the node cites
const W_MSG_CAP = 0.65; // message↔title overlap can contribute at most this

// Corroboration: when two independent signals each clear this floor, add a
// bonus — independent evidence converging is what we actually trust.
const CORROBORATION_FLOOR = 0.3;
const CORROBORATION_BONUS = 0.15;

const HIGH_CONFIDENCE = 0.85; // score at/above this is labelled "high", else "medium"

// Basename-only matches on these never count — they are touched by nearly
// every commit and would manufacture false links (the node's "shared barrel
// files, lockfiles" warning). Verbatim full-path matches still count.
const COMMON_BASENAMES = new Set([
  "index.js", "index.ts", "mod.rs", "__init__.py", "readme.md", "readme",
  "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "cargo.lock", "go.sum", "go.mod", "tsconfig.json", ".gitignore",
  "makefile", "dockerfile", "license",
]);

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "via", "out",
  "add", "adds", "added", "fix", "fixes", "fixed", "update", "updates",
  "updated", "use", "uses", "used", "make", "makes", "made", "wip", "tmp",
  "feat", "chore", "refactor", "test", "tests", "docs", "doc", "merge",
  "are", "was", "were", "not", "but", "its", "new", "now", "per", "one",
  "node", "nodes", "commit", "commits", "graph", "code",
]);

// ---------------------------------------------------------------------------
// normalization helpers
// ---------------------------------------------------------------------------

// Kebab-normalize one token the same way the hooks normalize project slugs
// and branch names: lowercase, non-alphanumerics → '-', trimmed.
function kebab(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tokens(s) {
  return kebab(s).split("-").filter(Boolean);
}

// Significant tokens for overlap scoring: drop stopwords and 1-2 char tokens
// (kept numerics like a year out by length too).
function significant(s) {
  return new Set(tokens(s).filter((t) => t.length >= 3 && !STOPWORDS.has(t)));
}

// The branch keys a node id can plausibly appear as. A branch is most often
// named for the work without the type/project prefix
// (overnight/commit-inference ↔ task-cc-commit-inference), so we admit the id
// with its first one or two leading segments removed — but only when the
// remainder is still specific (≥2 tokens), so generic ids (task-cc-fix → fix)
// can never match a generic branch.
function branchKeysFor(id) {
  const norm = kebab(id);
  const segs = norm.split("-").filter(Boolean);
  const keys = new Set();
  const consider = (arr) => {
    if (arr.length >= 2) keys.add(arr.join("-"));
  };
  keys.add(norm); // full id (always, exact)
  consider(segs.slice(1)); // drop type prefix
  consider(segs.slice(2)); // drop type + project prefix
  return keys;
}

// Path-like references inside a node's title+body: either a slash path with an
// extension (server/sandbox.js, lib/graph.js) or a bare filename with a short
// extension (sandbox.js). Returned normalized: { paths:Set, basenames:Set }.
function referencedPaths(text) {
  const paths = new Set();
  const basenames = new Set();
  const src = String(text || "");
  const slashRe = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6}/g;
  let m;
  while ((m = slashRe.exec(src)) !== null) {
    const p = m[0].toLowerCase();
    paths.add(p);
    basenames.add(p.slice(p.lastIndexOf("/") + 1));
  }
  const bareRe = /\b[\w-]+\.[A-Za-z0-9]{1,6}\b/g;
  while ((m = bareRe.exec(src)) !== null) {
    basenames.add(m[0].toLowerCase());
  }
  return { paths, basenames };
}

function basename(p) {
  const s = String(p || "").toLowerCase();
  const cut = s.lastIndexOf("/");
  return cut >= 0 ? s.slice(cut + 1) : s;
}

// ---------------------------------------------------------------------------
// per-signal scorers — each returns { weight, signal } | null
// ---------------------------------------------------------------------------

function scoreBranch(commit, node) {
  const branch = commit.branch;
  if (!branch) return null;
  // Branch segments (split on '/') plus the whole branch, each kebab'd.
  const segs = new Set();
  for (const part of String(branch).split("/")) {
    const k = kebab(part);
    if (k) segs.add(k);
  }
  segs.add(kebab(branch));
  const keys = branchKeysFor(node.id);
  const full = kebab(node.id);
  for (const seg of segs) {
    if (seg.length < 5) continue; // too short to be specific evidence
    if (seg === full) {
      return { weight: W_BRANCH_EXACT_ID, signal: { kind: "branch-id", detail: `branch '${branch}' names node id ${node.id}`, weight: W_BRANCH_EXACT_ID } };
    }
    if (keys.has(seg)) {
      return { weight: W_BRANCH_ID_TAIL, signal: { kind: "branch-id-tail", detail: `branch '${branch}' matches node id tail '${seg}' (${node.id})`, weight: W_BRANCH_ID_TAIL } };
    }
  }
  return null;
}

function scoreFiles(commit, node) {
  const files = Array.isArray(commit.files) ? commit.files : [];
  if (!files.length) return null;
  const ref = referencedPaths(`${node.title || ""}\n${node.body || ""}`);
  if (!ref.paths.size && !ref.basenames.size) return null;

  let best = 0;
  let detail = null;
  for (const f of files) {
    const lf = String(f || "").toLowerCase();
    if (!lf) continue;
    if (ref.paths.has(lf)) {
      // verbatim path the node cites — strongest, immune to the barrel-file caveat
      if (W_FILE_PATH > best) {
        best = W_FILE_PATH;
        detail = `commit touches '${f}', cited by the node`;
      }
      continue;
    }
    const bn = basename(lf);
    if (ref.basenames.has(bn) && !COMMON_BASENAMES.has(bn)) {
      if (W_FILE_BASENAME > best) {
        best = W_FILE_BASENAME;
        detail = `commit touches '${bn}', a filename the node cites`;
      }
    }
  }
  if (!best) return null;
  return { weight: best, signal: { kind: best >= W_FILE_PATH ? "file-path" : "file-basename", detail, weight: best } };
}

function scoreMessage(commit, node) {
  const subject = String(commit.message || "").split("\n")[0];
  const msg = significant(subject);
  const title = significant(node.title || "");
  if (title.size === 0 || msg.size === 0) return null;
  let inter = 0;
  for (const t of title) if (msg.has(t)) inter++;
  if (inter < 2) return null; // one shared word is not evidence
  const ratio = inter / title.size;
  let weight;
  if (ratio >= 0.8) weight = 0.65;
  else if (ratio >= 0.6) weight = 0.5;
  else if (ratio >= 0.4) weight = 0.35;
  else if (ratio >= 0.25) weight = 0.25;
  else return null;
  weight = Math.min(weight, W_MSG_CAP);
  return { weight, signal: { kind: "message-title", detail: `commit subject shares ${inter}/${title.size} significant title words`, weight } };
}

// ---------------------------------------------------------------------------
// combination
// ---------------------------------------------------------------------------

// Combine signals into one score. Base is the strongest single signal; when a
// SECOND independent signal also clears the corroboration floor we add a
// bounded bonus. This is deliberately not a sum — two weak signals must not
// masquerade as one strong one, but genuine independent corroboration should
// lift a borderline strong signal over the line.
function combine(signals) {
  if (!signals.length) return 0;
  const weights = signals.map((s) => s.weight).sort((a, b) => b - a);
  let score = weights[0];
  const corroborating = weights.filter((w) => w >= CORROBORATION_FLOOR).length;
  if (corroborating >= 2) score += CORROBORATION_BONUS;
  return Math.min(1, score);
}

// The $SPOR_INFER_THRESHOLD env override lives in the
// lib/commit-inference.js façade (REFACTOR.md §1 kernel/shell split) — the
// kernel sees only the resolved opts value.
function resolveThreshold(opts) {
  if (opts && typeof opts.threshold === "number" && isFinite(opts.threshold)) {
    return opts.threshold;
  }
  return DEFAULT_THRESHOLD;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

// Score one commit against many candidate nodes. Returns proposals (score ≥
// threshold) sorted strongest-first, each carrying the signals that fired and
// a plain-prose evidence sentence for the capture body.
//
//   commit:     { sha, repo, branch?, message?, files?:[] }
//   candidates: [ { id, title?, body?, commits?:[] } ]
//   opts:       { threshold?, maxProposals? }
function inferLinks(commit, candidates, opts = {}) {
  const threshold = resolveThreshold(opts);
  const maxProposals = opts.maxProposals || 3;
  const out = [];
  const repo = commit && commit.repo ? kebab(commit.repo) : null;
  const sha = commit && commit.sha ? String(commit.sha) : null;
  if (!sha || !Array.isArray(candidates)) {
    return { sha: sha || null, repo, threshold, proposals: [] };
  }

  for (const node of candidates) {
    if (!node || !node.id) continue;
    // Never re-propose a sha the node already records (prefix-aware), mirroring
    // the server's link_commit idempotency.
    if (alreadyLinked(node.commits, repo, sha)) continue;

    const fired = [];
    for (const fn of [scoreBranch, scoreFiles, scoreMessage]) {
      const r = fn(commit, node);
      if (r) fired.push(r.signal);
    }
    if (!fired.length) continue;
    const score = combine(fired);
    if (score < threshold) continue;

    out.push({
      nodeId: node.id,
      title: node.title || null,
      repo,
      sha,
      score: Math.round(score * 100) / 100,
      confidence: score >= HIGH_CONFIDENCE ? "high" : "medium",
      signals: fired,
      evidence: evidenceSentence(commit, node, fired, score),
    });
  }

  out.sort((a, b) => b.score - a.score);
  return { sha, repo, threshold, proposals: out.slice(0, maxProposals) };
}

function alreadyLinked(commits, repo, sha) {
  if (!Array.isArray(commits) || !repo || !sha) return false;
  const s = String(sha).toLowerCase();
  for (const c of commits) {
    const at = String(c).indexOf("@");
    if (at < 0) continue;
    const cRepo = c.slice(0, at).toLowerCase();
    const cSha = c.slice(at + 1).toLowerCase();
    if (cRepo !== repo) continue;
    if (s.startsWith(cSha) || cSha.startsWith(s)) return true;
  }
  return false;
}

// A plain-prose sentence the distiller can POST to /v1/capture. It states the
// inference and that it needs review, so the ingestion model proposes a
// reviewable link rather than the client stamping one.
function evidenceSentence(commit, node, signals, score) {
  const sha12 = String(commit.sha).slice(0, 12);
  const files = Array.isArray(commit.files) && commit.files.length
    ? ` touching ${commit.files.slice(0, 5).join(", ")}` : "";
  const onBranch = commit.branch ? ` on branch '${commit.branch}'` : "";
  const why = signals.map((s) => s.detail).join("; ");
  return `Inferred (needs review): commit ${commit.repo ? commit.repo + "@" : ""}${sha12}${onBranch}${files} ` +
    `appears to implement "${node.title || node.id}" (${node.id}). ` +
    `Confidence ${score.toFixed(2)}. Signals: ${why}. This is a guess from an untrailered commit, not an explicit declaration — link only if correct.`;
}

module.exports = {
  inferLinks,
  // exported for unit tests / reuse
  branchKeysFor,
  referencedPaths,
  combine,
  DEFAULT_THRESHOLD,
};

// The stdin/stdout CLI lives in the lib/commit-inference.js façade
// (REFACTOR.md §1 kernel/shell split).
