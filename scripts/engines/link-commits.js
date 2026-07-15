"use strict";
// Stamp Spor-trailered commits onto graph nodes (task-cc-commit-linking).
// Reads both the current `Spor:` trailer and the legacy `Substrate:` one.
// Node port of link-commits.sh — same marker-bounded range scan (never just
// HEAD), same 7-day/200-commit fallback window, same idempotent stamping and
// marker-advance-only-on-clean-transport semantics. Remote mode only;
// fail-open like every hook engine.
//
// Also runnable standalone (spawned detached by session-start's catch-up):
//   node link-commits.js <repo-dir>

const fs = require("fs");
const path = require("path");
const u = require("./util");

// Trailer -> node ids: split commas and lines, trim, keep ^[a-z0-9][a-z0-9-]*$.
// Dual-read both the current `Spor:` key and the legacy `Substrate:` key
// (commits made before the rename) so existing history keeps resolving.
function trailerNodeIds(top, sha) {
  const ids = [];
  for (const key of ["Spor", "Substrate"]) {
    const out = u.git(top, ["show", "-s", `--format=%(trailers:key=${key},valueonly)`, sha]);
    if (out === null) continue;
    for (const s of out.split(/[,\n]/)) {
      const v = s.trim();
      if (/^[a-z0-9][a-z0-9-]*$/.test(v) && !ids.includes(v)) ids.push(v);
    }
  }
  return ids;
}

async function linkCommits(repo) {
  if (!u.serverBase() || !repo) return;
  const top = u.git(repo, ["rev-parse", "--show-toplevel"])?.trim();
  if (!top) return;
  const head = u.git(top, ["rev-parse", "HEAD"])?.trim();
  if (!head) return;

  const graph = u.graphHome();
  const slug = u.projectSlug(top, "");
  if (!slug) return;
  if (!u.ensureDir(path.join(graph, "cache")) || !u.ensureDir(path.join(graph, "journal"))) return;
  const rlogFile = path.join(graph, "journal", "remote.log");
  const marker = path.join(graph, "cache", `commit-scan-${slug}`);

  let range = "";
  if (fs.existsSync(marker)) {
    let last = "";
    try {
      last = fs.readFileSync(marker, "utf8");
    } catch {}
    // The marker must still be reachable from HEAD (survives ordinary commits
    // and merges; a rebase or branch switch falls back to the window).
    if (last && u.git(top, ["merge-base", "--is-ancestor", last, "HEAD"]) !== null) {
      range = `${last}..HEAD`;
    }
  }

  const logOut = range
    ? u.git(top, ["log", "--format=%H", range])
    : u.git(top, ["log", "--since=7 days ago", "-200", "--format=%H"]);
  const shas = (logOut || "").split("\n").filter(Boolean);

  let failed = false;
  for (const sha of shas) {
    for (const nid of trailerNodeIds(top, sha)) {
      const { http } = await u.curl(`${u.serverBase()}/v1/nodes/${nid}/commits`, {
        method: "POST",
        headers: { ...u.bearer(), "Content-Type": "application/json" },
        body: JSON.stringify({ repo: slug, sha }),
        timeoutMs: 4000,
      });
      u.appendLine(
        rlogFile,
        `[${u.isoSeconds()}] link-commits ${slug}: ${sha.slice(0, 12)} -> ${nid} http=${http}`
      );
      if (http === "000" || http.startsWith("5")) failed = true;
    }
  }

  if (!failed) {
    // Atomic marker advance (write-then-rename, like marker.$$).
    try {
      u.writeFileAtomic(marker, head);
    } catch {}
  }
}

module.exports = { linkCommits, trailerNodeIds };

if (require.main === module) {
  linkCommits(process.argv[2] || "").catch(() => {}).finally(() => process.exit(0));
}
