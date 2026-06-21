// shell/gittime.js — the git + cache IO behind the loadGraph timestamp index
// (dec-spor-git-derived-timestamps). Every git spawn and cache read/write the
// index needs lives here; lib/kernel/timestamps.js does the pure fold. Plain
// Node, zero deps. Best-effort + fail-open by contract (dec-cc-fail-open-hooks):
// a non-git home, a missing git binary, or a torn cache returns null/empty —
// exactly like lib/queue.js's gitFront — so the index degrades to "nothing",
// never throws. The cache lives under the graph home's gitignored cache/ dir.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function git(repoDir, args, maxBuffer = 1 << 28) {
  const r = spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer, // a full-history --name-only fold can be large; a -p fold larger
  });
  return r.status === 0 ? (r.stdout ?? "") : null;
}

// Current HEAD sha, or null when the home is not a git repo / has no commits.
// null is the signal loadGraph uses to skip derivation entirely (no git ->
// graph.timestamps is null -> every consumer byte-identical).
function gitHead(repoDir) {
  const o = git(repoDir, ["rev-parse", "HEAD"]);
  return o == null ? null : o.trim() || null;
}

// Is `anc` an ancestor of `desc`? The fast-forward test that lets loadGraph fold
// only OLD..NEW. merge-base --is-ancestor exits 0 (yes) / 1 (no) / other (error);
// only a clean 0 counts, so an unknown/garbage cached sha (e.g. after a history
// rewrite) falls through to a full rebuild rather than a bad incremental fold.
function isAncestor(repoDir, anc, desc) {
  const r = spawnSync("git", ["-C", repoDir, "merge-base", "--is-ancestor", anc, desc], { stdio: "ignore" });
  return r.status === 0;
}

// `git log --name-only` over the nodes pathspec, newest-first, ACMR (adds/
// modifies/renames — pure deletes excluded, like gitFront). `range` (e.g.
// "OLD..NEW") folds only the new commits for the incremental update; absent =
// full history. Returns raw text or null (fail-open). %ct is the committer date
// in epoch seconds (UTC, unambiguous) — kernel.foldGitTimestamps parses it.
function logTimestamps(repoDir, nodesName, range) {
  const args = ["log", "--name-only", "--diff-filter=ACMR", "--format=%ct"];
  if (range) args.push(range);
  args.push("--", `${nodesName}/`);
  return git(repoDir, args);
}

// `git log -p` over the nodes pathspec, OLDEST commit first, restricted to the
// patch text the work-analytics consumer needs to fold each node's status
// timeline (task-spor-work-analytics-consumer). %x01 marks the per-commit epoch
// line unambiguously (no patch/content line begins with 0x01), --no-renames keeps
// a renamed file's new path carrying full +content, and --diff-filter=ACMR drops
// pure deletes (a removed node isn't tracked). `range` (e.g. "OLD..NEW") folds
// only the new commits for the HEAD-keyed incremental update
// (task-spor-analytics-closed-at-cache); absent = full history. Heavier than
// --name-only, so it rides a larger maxBuffer and is OFF the no-LLM prompt path
// (analytics only). Returns raw text or null (fail-open: a non-git home / oversized
// buffer / dead binary -> no completion data, never a throw).
// kernel.foldStatusTransitionState parses it.
function logStatusTransitions(repoDir, nodesName, range) {
  const args = ["log", "--reverse", "--no-renames", "--diff-filter=ACMR", "--format=%x01%ct", "-p"];
  if (range) args.push(range);
  args.push("--", `${nodesName}/`);
  return git(repoDir, args, 1 << 29);
}

// Atomic JSON cache write shared by both HEAD-keyed caches (timestamps +
// analytics status-transitions): write a pid-scoped temp then rename, so a
// concurrent reader never sees a half-written file (rename is atomic on POSIX).
// Fail-open: the cache is an optimization, so a write error (read-only home,
// full disk) is swallowed — the next load just re-folds.
function writeJsonCache(file, payload) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, file);
  } catch { /* fail-open */ }
}

// Read + shape-validate a JSON cache; a missing file (cold), a torn/half-written
// file, or a shape mismatch all read as null -> a full rebuild.
function readJsonCache(file, valid) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (valid(j)) return j;
  } catch { /* missing / torn / bad json -> cold rebuild */ }
  return null;
}

const cacheFile = (cacheDir) => path.join(cacheDir, "timestamps.json");

// The persisted timestamp cache: { head, ts: { id: { created_at, updated_at } } }.
// The git values are stored PURE (no frontmatter override) so the cache is keyed
// only on HEAD; the override is re-applied per load over the live node bytes.
function readCache(cacheDir) {
  return readJsonCache(cacheFile(cacheDir),
    (j) => j && typeof j.head === "string" && j.ts && typeof j.ts === "object");
}
function writeCache(cacheDir, head, ts) {
  writeJsonCache(cacheFile(cacheDir), { head, ts });
}

const closedCacheFile = (cacheDir) => path.join(cacheDir, "analytics-closed.json");

// The persisted analytics status-transition cache (task-spor-analytics-closed-at-
// cache): { head, fp, state: { id: { status, terminal, runStart } } }. HEAD-keyed
// like timestamps.json, plus `fp` — a fingerprint of the TERMINAL status
// vocabulary. Unlike the timestamp cache (which stores PURE, vocab-independent git
// times), the folded `state` bakes in isTerminal decisions, so a spor upgrade that
// changes the terminal set without a graph commit must invalidate it; `fp`
// captures that dependency. `state` is the per-node forward-walk state the fold
// composes onto (kernel.foldStatusTransitionState), not the closed-at output, so
// the OLD..NEW range fold can continue the walk.
function readClosedCache(cacheDir) {
  return readJsonCache(closedCacheFile(cacheDir),
    (j) => j && typeof j.head === "string" && typeof j.fp === "string" && j.state && typeof j.state === "object");
}
function writeClosedCache(cacheDir, head, fp, state) {
  writeJsonCache(closedCacheFile(cacheDir), { head, fp, state });
}

module.exports = {
  gitHead, isAncestor, logTimestamps, logStatusTransitions,
  readCache, writeCache, readClosedCache, writeClosedCache,
};
