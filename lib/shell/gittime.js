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

function git(repoDir, args) {
  const r = spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 1 << 28, // a full-history --name-only fold can be large
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

const cacheFile = (cacheDir) => path.join(cacheDir, "timestamps.json");

// The persisted client cache: { head, ts: { id: { created_at, updated_at } } }.
// A missing file (cold), a torn/half-written file, or a shape mismatch all read
// as null -> a full rebuild. The git values are stored PURE (no frontmatter
// override) so the cache is keyed only on HEAD; the override is re-applied per
// load over the live node bytes.
function readCache(cacheDir) {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(cacheDir), "utf8"));
    if (j && typeof j.head === "string" && j.ts && typeof j.ts === "object") return j;
  } catch { /* missing / torn / bad json -> cold rebuild */ }
  return null;
}

// Persist the cache atomically: write a pid-scoped temp then rename, so a
// concurrent reader never sees a half-written file (rename is atomic on POSIX).
// Fail-open: the cache is an optimization, so a write error (read-only home,
// full disk) is swallowed — the next load just re-folds.
function writeCache(cacheDir, head, ts) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = `${cacheFile(cacheDir)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ head, ts }));
    fs.renameSync(tmp, cacheFile(cacheDir));
  } catch { /* fail-open */ }
}

module.exports = { gitHead, isAncestor, logTimestamps, readCache, writeCache };
