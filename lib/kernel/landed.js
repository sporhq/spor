// kernel/landed.js — detect landed work: an open task/issue a commit REACHABLE
// FROM MAIN names (task-spor-landing-detect-shipped-resolver-draft).
//
// A `Spor: <id>` trailer, or a `commits:` stamp, says a commit serves a node —
// and on a busy graph plenty of those nodes stay open long after the commit
// shipped, because nothing writes their resolver. The server's git checks are
// SPOR_REPOS-gated (a hosted tenant has no checkouts), so this runs where git
// lives: the client, after a land and as a catch-up verb (`spor
// reconcile-landed`).
//
// Two rules keep it honest:
//   • "the commit exists" is never enough — a fix that lives only on a task
//     branch, or a done node whose sha main can't reach, is exactly the false
//     positive this is built against. The SHELL establishes reachability
//     (`git merge-base --is-ancestor <sha> <ref>`) and hands only commits that
//     passed it in; this file records which check each one passed.
//   • it DRAFTS, it never resolves. A trailer can name a node the commit only
//     relates to, and dec-spor-gardener-reversible-auto-write-class keeps
//     terminal status human. So each hit becomes an UNLINKED `art-*` draft
//     (status `in-review`, a `mentions` edge, never `resolves`) plus a
//     `find-shipped-on-main-*` finding asking a person to confirm the close.
//     Confirming (the shell's `--confirm`) is what promotes the draft, links
//     it and flips the status, through the ordinary doors.
//
// Ids are deterministic (bounded like the gardener's finding ids), so a
// re-run over the same range files nothing new: the writes are `if_exists:
// skip`. The finding kind `shipped-on-main` is deliberately NOT one of the
// gardener's own kinds, so its sweep never auto-resolves or re-opens it.
//
// Pure: no I/O, no clock, no node builtins — git, the graph load and the
// writes live in lib/shell/landed.js and bin/spor.js; a hash is injected.
"use strict";

const resolution = require("./resolution.js");

const FINDING_PREFIX = "find-shipped-on-main-";
const DRAFT_PREFIX = "art-shipped-";
// The server's write door caps (spor-server store-validate.js): an id over
// MAX_ID_LENGTH or a summary over MAX_SUMMARY_CHARS is refused outright.
const MAX_ID_LENGTH = 200;
const MAX_SUMMARY_CHARS = 500;
// How many commits a draft lists in its `commits:` field / body. A node named
// by hundreds of commits is not a close-candidate this helps with anyway.
const MAX_COMMITS = 20;
const WORK_TYPES = new Set(["task", "issue"]);
const NODE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

// Node ids named by a commit's trailer values (`%(trailers:key=Spor,valueonly)`
// output, possibly several lines, possibly comma-separated). Same parse as
// scripts/engines/link-commits.js trailerNodeIds.
function trailerIds(text) {
  const ids = [];
  for (const s of String(text || "").split(/[,\n]/)) {
    const v = s.trim();
    if (NODE_ID_RE.test(v) && !ids.includes(v)) ids.push(v);
  }
  return ids;
}

// The shas a node's `commits:` field stamps for `repo` (entries are
// `<repo>@<sha>`); malformed entries and other repos are ignored.
function commitsFieldShas(node, repo) {
  const out = [];
  for (const entry of Array.isArray(node && node.commits) ? node.commits : []) {
    const s = String(entry).trim();
    const at = s.lastIndexOf("@");
    if (at <= 0) continue;
    if (s.slice(0, at) !== repo) continue;
    const sha = s.slice(at + 1).toLowerCase();
    if (SHA_RE.test(sha) && !out.includes(sha)) out.push(sha);
  }
  return out;
}

// Bounded deterministic id: the plain join when it fits, else a short hash of
// the subject id (the gardener's boundedFindingId shape).
function boundedId(prefix, subjectId, hash) {
  const joined = `${prefix}${subjectId}`;
  if (joined.length <= MAX_ID_LENGTH) return joined;
  return `${prefix}${hash(subjectId).slice(0, 12)}`;
}
const findingId = (subjectId, hash) => boundedId(FINDING_PREFIX, subjectId, hash);
const draftId = (subjectId, hash) => boundedId(DRAFT_PREFIX, subjectId, hash);

// Why a node is not a close-candidate, or null when it is one: an open
// (live, unresolved, unsuperseded) task or issue.
function skipReason(graph, node, resolved) {
  if (!node) return "unknown";
  if (!WORK_TYPES.has(node.type)) return "not-work";
  if (graph.supersededBy && graph.supersededBy[node.id]) return "superseded";
  // An open execution hold: a factory controller owns this item's completion
  // (resolution.js executionHeld) — a second resolver would race its write.
  if (resolution.executionHeld(node)) return "held";
  if (resolution.isTerminalStatus(node.status, node.type, graph)) return "closed";
  if (resolved[node.id]) return "resolved";
  return null;
}

// plan({graph, repo, trailered, stamped}) -> {hits, skipped}
//   trailered: [{sha, subject, ids}] — commits in the scanned range, every one
//     already proven reachable from the ref by the caller.
//   stamped: Map<sha, {sha, subject}> | object — `commits:` shas the caller
//     proved reachable (keyed by the stamp as written, full or abbreviated).
//   exclude: ids never to file for (the land hook's own work item, whose
//     completion the runner owns).
// A hit is one open task/issue with every landed commit that names it, in
// scan order (trailer commits first, then stamps not already listed).
function plan({ graph, repo, trailered = [], stamped = {}, exclude = [] }) {
  const resolved = resolution.resolutionMap(graph);
  const excluded = new Set(exclude);
  const hits = new Map();
  const skipped = [];
  const add = (node, commit) => {
    let h = hits.get(node.id);
    if (!h) hits.set(node.id, (h = { id: node.id, node, commits: [] }));
    if (h.commits.some((c) => c.sha === commit.sha)) return;
    h.commits.push(commit);
  };
  for (const c of trailered) {
    for (const id of c.ids || []) {
      const node = graph.nodes[id];
      const why = excluded.has(id) ? "excluded" : skipReason(graph, node, resolved);
      if (why) {
        skipped.push({ id, sha: c.sha, source: "trailer", reason: why });
        continue;
      }
      add(node, { sha: c.sha, subject: c.subject || "", source: "trailer" });
    }
  }
  const stampedGet = (k) => (stamped instanceof Map ? stamped.get(k) : stamped[k]);
  for (const node of Object.values(graph.nodes)) {
    const shas = commitsFieldShas(node, repo);
    if (!shas.length || excluded.has(node.id) || skipReason(graph, node, resolved)) continue;
    for (const s of shas) {
      const c = stampedGet(s);
      if (!c) continue;
      const h = hits.get(node.id);
      if (h && h.commits.some((x) => x.sha === c.sha)) continue;
      add(node, { sha: c.sha, subject: c.subject || "", source: "commits-field" });
    }
  }
  const out = [...hits.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { hits: out, skipped };
}

// One line, bounded, safe inside a `key: value` frontmatter scalar.
function oneLine(s, max) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
const bounded = (s) => oneLine(s, MAX_SUMMARY_CHARS);

// The two node files for a hit. `check` describes the reachability test every
// listed commit passed: {ref, tip} — `git merge-base --is-ancestor <sha> <ref>`
// with <ref> at <tip>. `completion` is the subject type's declared success
// status (registry.completionStatus), named in the confirm instructions.
function render(hit, { repo, check, date, hash, completion: declared = null }) {
  const subject = hit.node;
  const fid = findingId(hit.id, hash);
  const did = draftId(hit.id, hash);
  const commits = hit.commits.slice(0, MAX_COMMITS);
  const more = hit.commits.length - commits.length;
  const short = (sha) => sha.slice(0, 12);
  const first = commits[0];
  const refLine = `\`git merge-base --is-ancestor <sha> ${check.ref}\` passed for every listed commit (${check.ref} at \`${short(check.tip)}\`)`;
  const commitLines = commits.map((c) =>
    `- \`${repo}@${c.sha}\` — ${oneLine(c.subject, 120) || "(no subject)"} (${c.source === "trailer" ? "`Spor:` trailer" : "`commits:` stamp"})`);
  if (more > 0) commitLines.push(`- … and ${more} more`);
  const completion = declared || (subject.type === "issue" ? "resolved" : "done");
  const titleOf = oneLine(subject.title || subject.id, 120);
  const node = (front, paragraphs) =>
    `---\n${front.filter((l) => l != null).join("\n")}\n---\n\n${paragraphs.join("\n\n")}\n`;
  const project = subject.project ? `project: ${subject.project}` : null;

  const draft = node([
    `id: ${did}`,
    "type: artifact",
    project,
    `title: ${oneLine(`Shipped on ${check.ref}: ${titleOf}`, 200)}`,
    `summary: ${bounded(`DRAFT resolver for ${hit.id}: ${hit.commits.length === 1 ? "a commit" : `${hit.commits.length} commits`} naming it landed on ${check.ref} of ${repo} (${commits.map((c) => short(c.sha)).join(", ")}${more > 0 ? ", …" : ""})${first.subject ? ` — ${oneLine(first.subject, 140)}` : ""}. Unlinked until a person confirms the close.`)}`,
    "status: in-review",
    `date: ${date}`,
    `commits: [${commits.map((c) => `${repo}@${c.sha}`).join(", ")}]`,
    "edges:",
    `  - {type: mentions, to: ${hit.id}}`,
    "authored_via: reconcile-landed",
  ], [
    `Drafted by \`spor reconcile-landed\`: ${hit.id} is named by ${hit.commits.length === 1 ? "a commit" : `${hit.commits.length} commits`} now reachable from \`${check.ref}\` in \`${repo}\`.`,
    commitLines.join("\n"),
    `Reachability: ${refLine}.`,
    `This is a DRAFT: status \`in-review\` and no \`resolves\` edge, so it retires nothing. A trailer can name a node the commit only relates to — confirming the close (\`spor reconcile-landed --confirm ${fid}\`) is what marks this \`merged\`, adds \`resolves → ${hit.id}\` and sets ${hit.id} \`${completion}\`.`,
  ]);

  const finding = node([
    `id: ${fid}`,
    "type: finding",
    project,
    `title: ${oneLine(`Shipped on ${check.ref} — confirm close: ${hit.id}`, 200)}`,
    `summary: ${bounded(`${hit.id} is still ${subject.status || "open"}, but ${hit.commits.length === 1 ? `commit ${short(first.sha)} naming it is` : `${hit.commits.length} commits naming it are`} reachable from ${check.ref} in ${repo} (git merge-base --is-ancestor passed). Confirm the close, or dismiss if the commit only relates to it.`)}`,
    "status: open",
    `date: ${date}`,
    "edges:",
    `  - {type: relates-to, to: ${hit.id}}`,
    `  - {type: relates-to, to: ${did}}`,
    "authored_via: reconcile-landed",
  ], [
    `\`${hit.id}\` (${subject.type}, status \`${subject.status || "open"}\`) looks shipped: ${hit.commits.length === 1 ? "a commit that names it is" : "commits that name it are"} on \`${check.ref}\` in \`${repo}\`.`,
    commitLines.join("\n"),
    `Reachability check passed: ${refLine}. A commit that exists only on a branch never files this finding.`,
    `The resolver is drafted, unlinked, as \`${did}\`. To confirm (batch-confirmable — pass every id at once): \`spor reconcile-landed --confirm ${fid} [<more finding ids>…]\` — it marks the draft \`merged\`, adds \`resolves → ${hit.id}\`, sets it \`${completion}\` and resolves this finding. If the commit only relates to ${hit.id}, set this finding \`dismissed\` instead; the draft stays inert.`,
  ]);

  return { findingId: fid, draftId: did, draft, finding };
}

// confirmTargets(finding, hash) -> {subject, draft} | {error}: the subject and
// draft a `find-shipped-on-main-*` finding names, read off its edges and
// cross-checked against the deterministic draft id (so a hand-edited or
// foreign finding is refused rather than acted on).
function confirmTargets(finding, hash) {
  if (!finding || finding.type !== "finding" || !String(finding.id || "").startsWith(FINDING_PREFIX)) {
    return { error: "not a reconcile-landed finding (find-shipped-on-main-*)" };
  }
  const rel = (finding.edges || []).filter((e) => e && e.type === "relates-to" && e.to).map((e) => e.to);
  const subjects = rel.filter((to) => !to.startsWith(DRAFT_PREFIX));
  if (subjects.length !== 1) return { error: `expected exactly one subject edge, found ${subjects.length}` };
  const subject = subjects[0];
  if (findingId(subject, hash) !== finding.id) return { error: `finding id does not match its subject ${subject}` };
  const draft = draftId(subject, hash);
  if (!rel.includes(draft)) return { error: `finding does not name its draft ${draft}` };
  return { subject, draft };
}

module.exports = {
  FINDING_PREFIX, DRAFT_PREFIX, MAX_COMMITS, SHA_RE,
  trailerIds, commitsFieldShas, findingId, draftId, skipReason, plan, render, confirmTargets,
};
