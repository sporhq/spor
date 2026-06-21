"use strict";
// history.js — the LOCAL arm of `spor history <id> [<sha>]` (task-spor-history-
// cli-verb): a per-node `git log` lineage projection over a graph's
// nodes/<id>.md, plus the shared renderers both modes print through. The REMOTE
// arm (bin/spor.js cmdHistory) wraps GET /v1/nodes/{id}/history (the cheap commit
// list) and GET /v1/nodes/{id}/history/{sha} (one revision's diff + content);
// this produces the SAME envelope shapes from the local graph's git history so
// the rendered output matches across modes (norm-spor-cli-mode-parity). The
// server keeps the node_history MCP tool and both REST routes on ONE pair of
// cores (computeNodeHistory / computeNodeHistoryEntry, spor-server rest.js); this
// is the faithful local twin of that git-log projection. Zero deps — the git
// binary + node builtins only.
//
// Why the per-node history exists at all: every node write is a git commit
// authored by the acting identity, but the frontmatter `author` field re-stamps
// to the LAST editor on every write, so `git log` over the node file is the only
// durable record of the full chain of editors (who / when / what changed).
//
// Deliberately NOT `git log --follow` (dec-spor-node-history-git-log-projection):
// node files share heavy frontmatter boilerplate, so git's content-similarity
// rename detection spuriously pairs a node's creation commit with an unrelated,
// similar node and follows into ITS history — pulling other nodes' commits into
// this node's lineage. Plain `git log -- nodes/<id>.md` keeps the lineage clean.
//
// List envelope: { id, head, count, history: [{sha, short, actor, actor_name,
//   actor_email, date, message, internal, person}] }, newest commit first.
// Entry envelope: { ...one history record, id, change, patch, content } where
//   change is the git --name-status letter (A|M|D|R), patch is the unified diff
//   this commit introduced to the node file (trailing newline trimmed, matching
//   the server), and content is the full node markdown at that revision (null
//   when the commit DELETED the file). `date` is `%cI` (committer date, ISO 8601
//   with offset) exactly as the server emits it.

const path = require("path");
const { spawnSync } = require("child_process");

// limit floor/ceiling/default mirror the server (HISTORY_DEFAULT_LIMIT/
// HISTORY_MAX_LIMIT in spor-server rest.js): default 50, hard max 200, min 1.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// store.js commits its own internal writes (boot working-tree reconcile,
// migrations) under this stable identity rather than a person; a history entry
// from this author is labeled `internal: true` so a reader can tell a server-
// internal write from a real actor. Kept in lockstep with the server literal.
const INTERNAL_EMAIL = "server@spor.invalid";

function clampLimit(v) {
  return Math.min(MAX_LIMIT, Math.max(1, Number(v) || DEFAULT_LIMIT));
}

function isShaLike(s) {
  return typeof s === "string" && /^[0-9a-f]{7,40}$/i.test(s);
}

// A node id is a kebab-case slug (the server's SLUG_RE); reject anything else
// before touching git so a stray `--` or path separator can't reach the pathspec.
function isNodeId(s) {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]*$/.test(s);
}

// Run git in the graph repo. Returns stdout on success (possibly ""), or null
// when git exits non-zero — the caller distinguishes "" (ran, no output) from
// null (failed / unresolvable ref), exactly as the server's gitLines does.
function git(repoDir, args, maxBuffer = 1 << 28) {
  const r = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8", maxBuffer });
  if (r.status !== 0) return null;
  return r.stdout;
}

// Map a git author email (lowercased) to the person node that owns it, so a
// history entry can point a real actor back to their graph node. The faithful
// twin of the server's personEmailIndex(store.graph): persons carry an `email`
// field, so this indexes type:person nodes by lowercased email → person id.
// Takes a loaded graph ({ nodes }); a null/empty graph yields an empty index
// (person stays null, the actor name/email still renders).
function personEmailIndex(graph) {
  const idx = new Map();
  for (const [id, n] of Object.entries((graph && graph.nodes) || {})) {
    if (n && n.type === "person" && typeof n.email === "string" && n.email) {
      idx.set(n.email.toLowerCase(), id);
    }
  }
  return idx;
}

// Decorate a raw {sha,date,name,email,subject} commit record with the internal-
// vs-actor label and the person mapping. `emailIdx` is personEmailIndex(graph).
// Byte-faithful twin of the server's decorateHistoryActor.
function decorateActor(rec, emailIdx) {
  const email = (rec.email || "").toLowerCase();
  const internal = email === INTERNAL_EMAIL;
  const person = !internal && email && emailIdx ? emailIdx.get(email) || null : null;
  return {
    sha: rec.sha || null,
    short: rec.sha ? rec.sha.slice(0, 7) : null,
    actor: rec.name && rec.email ? `${rec.name} <${rec.email}>` : rec.name || null,
    actor_name: rec.name || null,
    actor_email: rec.email || null,
    date: rec.date || null,
    message: rec.subject || null,
    internal, // a server-internal write (boot reconcile / migration), not a real actor
    person, // the person node this actor maps to, or null
  };
}

// The git log format both cores parse: full sha, committer date (%cI), author
// name/email, subject — \x1f-separated. Mirrors the server's fmt exactly.
const LOG_FMT = "--format=%H\x1f%cI\x1f%an\x1f%ae\x1f%s";

// collect({nodesDir, id, limit, emailIdx}) -> { id, head, count, history }. The
// local twin of computeNodeHistory: a `git log` projection over nodes/<id>.md,
// newest first. A count of 0 means no commit ever touched the path (the id never
// existed) — the CLI maps that to the server's 404. Throws an Error with
// `.code = "git_error"` when the log itself fails. A non-git / empty home returns
// head:null, count:0 (fail-open, like changes.js / analytics).
function collect({ nodesDir, id, limit, emailIdx = null } = {}) {
  const repoDir = path.dirname(nodesDir);
  const nodesName = path.basename(nodesDir);
  const cap = clampLimit(limit);

  const head = (git(repoDir, ["rev-parse", "HEAD"]) || "").trim() || null;
  if (!head) return { id, head: null, count: 0, history: [] };

  const raw = git(repoDir, ["log", LOG_FMT, "-n", String(cap), "--", `${nodesName}/${id}.md`], 1 << 29);
  if (raw == null) {
    const e = new Error(`could not read history for '${id}'`);
    e.code = "git_error";
    throw e;
  }
  const history = [];
  for (const line of raw.split("\n")) {
    if (!line.includes("\x1f")) continue;
    const [sha, date, name, email, subject] = line.split("\x1f");
    history.push(decorateActor({ sha, date, name, email, subject }, emailIdx));
  }
  return { id, head, count: history.length, history };
}

// collectEntry({nodesDir, id, sha, emailIdx}) -> { ok, response } | { ok:false,
// code }. The local twin of computeNodeHistoryEntry: one revision's metadata, the
// change letter, the patch this commit introduced to the node, and the full node
// content at that revision. Codes mirror the server: "empty" (no commits),
// "bad_sha" (sha unresolvable), "not_in_history" (the commit didn't touch the
// node), "git_error".
function collectEntry({ nodesDir, id, sha, emailIdx = null } = {}) {
  const repoDir = path.dirname(nodesDir);
  const rel = `${path.basename(nodesDir)}/${id}.md`;

  if (!(git(repoDir, ["rev-parse", "HEAD"]) || "").trim()) return { ok: false, code: "empty" };

  // Metadata + name-status for EXACTLY this commit, restricted to the node path.
  // With a pathspec, `git show` prints nothing (rc 0, empty) when the commit
  // didn't touch the path — distinct from an unresolvable sha (rc != 0 -> null).
  const metaRaw = git(repoDir, ["show", "--no-color", LOG_FMT, "--name-status", sha, "--", rel]);
  if (metaRaw == null) return { ok: false, code: "bad_sha" };
  const lines = metaRaw.split("\n");
  const metaLine = lines.find((l) => l.includes("\x1f"));
  if (!metaLine) return { ok: false, code: "not_in_history" };
  const [fullSha, date, name, email, subject] = metaLine.split("\x1f");
  const statusLine = lines.find((l) => /^[AMD]\t/.test(l) || /^R\d+\t/.test(l));
  const change = statusLine ? statusLine[0] : null; // A | M | D | R
  const meta = decorateActor({ sha: fullSha, date, name, email, subject }, emailIdx);

  // The patch this commit introduced to the node file, and the full node content
  // AT this revision (`git show <sha>:<rel>` — null when the commit DELETED the
  // file, since it is absent from that commit's tree).
  const patch = git(repoDir, ["show", "--no-color", "--format=", "-p", fullSha, "--", rel]);
  // `<rev>:./<path>` resolves <path> relative to the cwd (-C repoDir), NOT the
  // repo root — robust when the graph home's nodes/ is nested inside a larger git
  // repo (the `graph:` marker / monorepo case), where a root-relative
  // `<rev>:<path>` misses. The pathspec reads above are already cwd-relative, so
  // this keeps all three reads consistent; with the home AT the repo root (the
  // server's own case) the two forms are identical.
  const content = git(repoDir, ["show", `${fullSha}:./${rel}`]);
  return {
    ok: true,
    response: {
      ...meta,
      id,
      change,
      patch: patch == null ? null : patch.replace(/\n$/, ""),
      content: content == null ? null : content,
    },
  };
}

// Expand a git --name-status letter to a readable label for the text view (the
// --json keeps the raw letter, matching the server).
function changeLabel(letter) {
  switch (letter) {
    case "A":
      return "created";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return letter || "?";
  }
}

// "2026-06-21T15:57:18+00:00" -> "2026-06-21 15:57" (sliced to the minute), the
// same instant the changes feed renders.
function whenOf(date) {
  return String(date || "").slice(0, 16).replace("T", " ");
}

// The actor column: a server-internal write reads "server (internal)"; a real
// actor reads its "Name <email>" (or bare name), falling back to "(unknown)".
function actorOf(rec) {
  if (rec.internal) return "server (internal)";
  return rec.actor || "(unknown)";
}

// renderList(envelope) -> human text. Shared by the local and remote arms so
// output matches (the remote arm passes the server's JSON straight in). One
// revision per stanza: short sha + when + actor (+ person), then the message.
function renderList(env) {
  const { id, history = [], count = 0, head = null } = env || {};
  const lines = [`${id} — ${count} revision${count === 1 ? "" : "s"}`];
  for (const h of history) {
    const who = actorOf(h);
    const person = h.person ? `  [${h.person}]` : "";
    lines.push(`  ${h.short || "???????"}  ${whenOf(h.date)}  ${who}${person}`);
    if (h.message) lines.push(`      ${h.message}`);
  }
  if (head) lines.push(`  (head ${String(head).slice(0, 8)})`);
  return lines.join("\n");
}

// renderEntry(entry, {content}) -> human text: the revision header (short sha,
// change, actor, when), the message, then the patch this commit introduced. With
// {content:true} the full node markdown at that revision is appended. A deleted
// revision has no content; a commit with no textual diff has no patch.
function renderEntry(entry, { content = false } = {}) {
  const e = entry || {};
  const who = actorOf(e);
  const person = e.person ? `  [${e.person}]` : "";
  const change = changeLabel(e.change);
  const lines = [
    `${e.short || e.sha || "?"}  ${change}  ${e.id}`,
    `  ${who}${person}  ·  ${whenOf(e.date)}`,
  ];
  if (e.message) lines.push(`  ${e.message}`);
  lines.push("");
  lines.push(e.patch ? e.patch : "  (no diff for this revision)");
  if (content) {
    lines.push("");
    lines.push(`--- content @ ${e.short || e.sha || "?"} ---`);
    lines.push(e.content != null ? e.content : "  (node absent at this revision)");
  }
  return lines.join("\n");
}

module.exports = {
  collect,
  collectEntry,
  personEmailIndex,
  decorateActor,
  renderList,
  renderEntry,
  changeLabel,
  clampLimit,
  isShaLike,
  isNodeId,
  INTERNAL_EMAIL,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
