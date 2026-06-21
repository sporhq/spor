"use strict";
// changes.js — the LOCAL arm of `spor changes` (task-spor-changes-cli-verb): a
// git-log "recent changes" projection over a graph's nodes/ dir, plus the shared
// renderer both modes print through. The REMOTE arm (bin/spor.js cmdChanges)
// wraps GET /v1/changes; this produces the SAME envelope shape from the local
// graph's git history so the rendered output matches across modes
// (norm-spor-cli-mode-parity). The server keeps recent_changes (MCP) and GET
// /v1/changes on ONE core; this is the faithful local twin of that git-log
// projection (API.md recent_changes / §3). Zero deps — the git binary + node
// builtins only.
//
// Envelope: { changes: [{id, change, commit, date, committed_by, type, title,
//   authored_via, author, authored_by_agent, session}], count, head, since,
//   project, node_ids }. `change` is the raw git --name-status LETTER (A/M/D),
//   matching GET /v1/changes byte-for-byte (verified against the live server —
//   the field is the letter, not a word); the shared renderer expands it to a
//   readable label for the text view. One entry per node = its NEWEST change in
//   the range, newest-first. Each non-deleted entry is decorated from the node's
//   CURRENT frontmatter (type/title/authored_via/author/authored_by_agent/
//   session) — the trust signal the rendered digest hides. The optional
//   `keep(fm)` predicate filters entries (the CLI supplies the SAME grouping-
//   union project resolution `next`/`analytics` use, so `--project` means one
//   thing across verbs; a deletion has fm=null and is dropped when scoped,
//   matching the server). `project` is stamped on the envelope for display only.
//   The CLI stamps `generated_at`; the kernel stays time-free so its output is
//   deterministic for tests.
//
// `date` is `%ct`→toISOString() (UTC `Z`, deterministic) where the server emits
// `%cI` (offset form) — the same instant, and the rendered view (sliced to the
// minute) is identical; only the raw --json string form differs by timezone
// notation, which is not a cross-mode contract.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { parseFrontmatter } = require("./kernel/graph.js");

// authored_via values the server treats as machine-written; everything else is
// human (API.md recent_changes). Kept in lockstep with the server's table.
const MACHINE_VIA = new Set(["capture", "distill", "gardener"]);

// limit defaults + ceiling mirror GET /v1/changes (API.md §3): default 100,
// hard max 500. A non-numeric / <=0 limit falls back to the default.
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function clampLimit(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function isShaLike(s) {
  return typeof s === "string" && /^[0-9a-f]{7,40}$/i.test(s);
}

function git(repoDir, args, maxBuffer = 1 << 28) {
  const r = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8", maxBuffer });
  if (r.status !== 0) return null;
  return r.stdout;
}

// Expand a git --name-status letter to a readable label for the TEXT view (the
// JSON keeps the raw letter, matching the server). With --no-renames a rename
// decomposes into D(old)+A(new), so R/C/T are defensive only.
function changeLabel(letter) {
  switch (letter) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typechange";
    default:
      return letter || "?";
  }
}

// collect({nodesDir, since, project, limit}) -> envelope. Throws an Error with
// `.code = "bad_since"` when a sha-like `since` doesn't resolve to a commit
// (mirroring the server's 422). A non-git / empty home returns an empty envelope
// (fail-open, like analytics' deriveStatusTransitions).
function collect({ nodesDir, since = null, project = null, limit, keep = null } = {}) {
  const cap = clampLimit(limit);
  const repoDir = path.dirname(nodesDir);
  const nodesName = path.basename(nodesDir);
  const empty = { changes: [], count: 0, head: null, since: since || null, project: project || null, node_ids: [] };

  const head = (git(repoDir, ["rev-parse", "HEAD"]) || "").trim() || null;
  if (!head) return empty; // non-git home / no commits -> nothing to project

  // `since`: a 7-40 hex sha is a `<sha>..HEAD` range (the sha must resolve, else a
  // bad_since error); any other value is a date/relative phrase git understands
  // (passed as --since), exactly as the server splits them (API.md §3).
  const logArgs = ["log", "--no-renames", "--name-status", "--diff-filter=ACMRD", "--format=\x01%H\x1f%ct\x1f%cn\x1f%ce"];
  if (since) {
    if (isShaLike(since)) {
      const ok = spawnSync("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", `${since}^{commit}`], { stdio: "ignore" });
      if (ok.status !== 0) {
        const e = new Error(`could not resolve --since '${since}' as a commit`);
        e.code = "bad_since";
        throw e;
      }
      logArgs.push(`${since}..HEAD`);
    } else {
      logArgs.push(`--since=${since}`);
    }
  }
  logArgs.push("--", `${nodesName}/`);

  const log = git(repoDir, logArgs, 1 << 29);
  if (log === null) return { ...empty, head }; // git log failed -> fail-open

  // Walk newest-first; the FIRST status line seen for a path is its newest change
  // in range. One entry per node id (first wins). Header lines start with \x01.
  const seen = new Set();
  const changes = [];
  let cur = null; // { commit, date, committed_by }
  for (const line of log.split("\n")) {
    if (!line) continue;
    if (line[0] === "\x01") {
      const [h, ct, cn, ce] = line.slice(1).split("\x1f");
      const committed_by = cn ? (ce ? `${cn} <${ce}>` : cn) : ce || null;
      cur = { commit: h, date: new Date(Number(ct) * 1000).toISOString(), committed_by };
      continue;
    }
    if (!cur) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const letter = line[0]; // raw git --name-status letter (A/M/D), as the server emits
    const file = line.slice(tab + 1).trim();
    if (!file.endsWith(".md") || !file.startsWith(`${nodesName}/`)) continue;
    const id = path.basename(file, ".md");
    if (seen.has(id)) continue; // newest change already recorded for this node
    seen.add(id);
    changes.push({ id, change: letter, commit: cur.commit, date: cur.date, committed_by: cur.committed_by });
  }

  // Decorate from the CURRENT node file. A deleted node has no current file:
  // keep null type/title. The optional `keep(fm)` predicate filters (project
  // scope etc.); a deletion passes fm=null, so a project-scoped keep drops it
  // (its project is gone, matching the server — API.md §3).
  const decorated = [];
  for (const c of changes) {
    let fm = null;
    if (c.change !== "D") {
      try {
        fm = parseFrontmatter(fs.readFileSync(path.join(nodesDir, `${c.id}.md`), "utf8"), `${c.id}.md`);
      } catch {
        /* unreadable / unparseable current file -> undecorated entry */
      }
    }
    if (keep && !keep(fm)) continue;
    decorated.push({
      id: c.id,
      change: c.change,
      commit: c.commit,
      date: c.date,
      committed_by: c.committed_by,
      type: fm ? fm.type || null : null,
      title: fm ? fm.title || null : null,
      authored_via: fm ? fm.authored_via || null : null,
      author: fm ? fm.author || null : null,
      authored_by_agent: fm ? fm.authored_by_agent || null : null,
      session: fm ? fm.session || null : null,
    });
    if (decorated.length >= cap) break;
  }

  return {
    changes: decorated,
    count: decorated.length,
    head,
    since: since || null,
    project: project || null,
    node_ids: decorated.map((c) => c.id),
  };
}

function trust(av) {
  return MACHINE_VIA.has(av) ? `machine·${av}` : "human";
}

// renderReport(envelope) -> human text. Shared by the local and remote arms so
// output matches (the remote arm passes the server's JSON straight in). One node
// per stanza: when + change + id, then the title with its type and machine/human
// trust marker.
function renderReport(report) {
  const { changes = [], count = 0, project = null, since = null, head = null } = report || {};
  const scope = project ? ` — project ${project}` : "";
  const sinceLbl = since ? `, since ${since}` : "";
  const lines = [`recent changes${scope} (${count} node${count === 1 ? "" : "s"}${sinceLbl})`];
  if (!changes.length) {
    lines.push("  (nothing changed in range)");
    return lines.join("\n");
  }
  for (const c of changes) {
    const when = String(c.date || "").slice(0, 16).replace("T", " ");
    const change = changeLabel(c.change).padEnd(10);
    lines.push(`  ${when}  ${change}  ${c.id}`);
    const meta = [c.type, trust(c.authored_via)].filter(Boolean).join(", ");
    const title = c.title || (c.change === "D" ? "(deleted)" : "");
    lines.push(`      ${title}${meta ? `  [${meta}]` : ""}`);
  }
  if (head) lines.push(`  (head ${String(head).slice(0, 8)})`);
  return lines.join("\n");
}

module.exports = { collect, renderReport, changeLabel, clampLimit, isShaLike, MACHINE_VIA, DEFAULT_LIMIT, MAX_LIMIT };
