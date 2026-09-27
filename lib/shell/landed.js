// shell/landed.js — the git half of landed-work detection
// (task-spor-landing-detect-shipped-resolver-draft; the pure half is
// lib/kernel/landed.js). Everything here reads one code checkout: which
// commits in a range carry a `Spor:` (or legacy `Substrate:`) trailer, and
// whether a `commits:` stamp's sha is REACHABLE FROM the ref. Reachability is
// always `git merge-base --is-ancestor <sha> <tip>`, and an answer git could
// not give (a missing object, an errored probe) is NOT reachable — a finding
// is filed only on evidence, never on the absence of a "no".
//
// No graph I/O and no writes: bin/spor.js loads the graph, calls collect(),
// hands the result to kernel.plan()/render(), and writes the nodes.
"use strict";

const { gitSpawn } = require("./git-exec.js");

// The trunk refs tried, in order, when no --ref is given — the same list the
// set-status ancestry warning reads (bin/spor.js ANCESTRY_TRUNK_REFS).
const DEFAULT_REFS = ["main", "master", "origin/main", "origin/master"];
const DEFAULT_LAST = 200;

const git = (dir, args) => gitSpawn(dir, args, { timeout: 30000 });
const ok = (r) => !r.error && r.status === 0;

function revParse(dir, spec) {
  const r = git(dir, ["rev-parse", "--verify", "--quiet", `${spec}^{commit}`]);
  return ok(r) ? String(r.stdout || "").trim() : null;
}

// true (ancestor) | false (definitively not) | null (git could not answer)
function isAncestor(dir, sha, tip) {
  const r = git(dir, ["merge-base", "--is-ancestor", sha, tip]);
  if (r.error) return null;
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

// resolveRef(dir, ref) -> {ref, tip} | {error}: the named ref, or the first
// default trunk ref that resolves.
function resolveRef(dir, ref) {
  const tried = ref ? [ref] : DEFAULT_REFS;
  for (const r of tried) {
    const tip = revParse(dir, r);
    if (tip) return { ref: r, tip };
  }
  return { error: ref ? `ref '${ref}' does not resolve to a commit` : `no trunk ref resolves (tried ${DEFAULT_REFS.join(", ")}) — pass --ref` };
}

const SEP_FIELD = "\x1f";
const SEP_RECORD = "\x1e";

// scanTrailers({dir, tip, since, last}) -> {commits: [{sha, subject, ids}],
// all: [{sha, subject}]} | {error}. `since` bounds the range to `since..tip`
// (the land hook passes the target's pre-land tip); otherwise the last `last`
// commits reachable from tip. `commits` holds only those naming at least one
// node; `all` every commit in the range. Both oldest first.
function scanTrailers(kernel, { dir, tip, since = null, last = DEFAULT_LAST }) {
  const fmt = ["%H", "%s", "%(trailers:key=Spor,valueonly)", "%(trailers:key=Substrate,valueonly)"].join(SEP_FIELD) + SEP_RECORD;
  const range = since ? [`${since}..${tip}`] : [`--max-count=${last}`, tip];
  const r = git(dir, ["log", "--reverse", `--format=${fmt}`, ...range]);
  if (!ok(r)) return { error: `git log failed: ${String(r.stderr || r.error || "").trim().split("\n")[0] || "unknown error"}` };
  const commits = [];
  const all = [];
  for (const rec of String(r.stdout || "").split(SEP_RECORD)) {
    const parts = rec.replace(/^\n+/, "").split(SEP_FIELD);
    if (parts.length < 4 || !parts[0]) continue;
    all.push({ sha: parts[0], subject: parts[1] });
    const ids = kernel.trailerIds(`${parts[2]}\n${parts[3]}`);
    if (ids.length) commits.push({ sha: parts[0], subject: parts[1], ids });
  }
  // --reverse with --max-count applies the limit BEFORE reversing, so this is
  // the newest `last` commits, oldest first.
  return { commits, all };
}

// collect({kernel, graph, dir, repo, ref, since, last}) -> {ref, tip, since,
// trailered, stamped, unverified} | {error}. The input kernel.plan() needs:
//   trailered — trailer commits in range, each re-proven with --is-ancestor
//   stamped   — Map<stamp sha, {sha, subject}> for every `commits:` stamp of
//               this repo on an open task/issue that is reachable from tip.
//               With `since`, only stamps that landed IN the range — matched
//               against the range's own commit list (prefix-aware), so a land
//               costs one `git log`, not a probe per stamp in the graph.
//   unverified — stamps/commits git could not judge (reported, never filed)
function collect({ kernel, graph, dir, repo, ref = null, tip = null, since = null, last = DEFAULT_LAST }) {
  let resolved;
  if (tip) {
    const full = revParse(dir, tip);
    if (!full) return { error: `tip '${tip}' does not resolve to a commit` };
    resolved = { ref: ref || full.slice(0, 12), tip: full };
  } else {
    resolved = resolveRef(dir, ref);
    if (resolved.error) return resolved;
  }
  let sinceSha = null;
  if (since) {
    sinceSha = revParse(dir, since);
    if (!sinceSha) return { error: `--since '${since}' does not resolve to a commit` };
  }
  const scan = scanTrailers(kernel, { dir, tip: resolved.tip, since: sinceSha, last });
  if (scan.error) return scan;
  const unverified = [];
  const trailered = [];
  for (const c of scan.commits) {
    const a = isAncestor(dir, c.sha, resolved.tip);
    if (a === true) trailered.push(c);
    else unverified.push({ sha: c.sha, source: "trailer", reason: a === false ? "not-reachable" : "git-error" });
  }

  const stamped = new Map();
  const resolvedMap = require("../kernel/resolution.js").resolutionMap(graph);
  for (const node of Object.values(graph.nodes)) {
    const shas = kernel.commitsFieldShas(node, repo);
    if (!shas.length || kernel.skipReason(graph, node, resolvedMap)) continue;
    for (const s of shas) {
      if (stamped.has(s)) continue;
      if (sinceSha) {
        const hit = scan.all.find((c) => c.sha.startsWith(s));
        // An abbreviated stamp must name THIS commit unambiguously in the
        // repo, not just share a prefix with one in the range.
        if (hit && (s.length === 40 || revParse(dir, s) === hit.sha)) stamped.set(s, { sha: hit.sha, subject: hit.subject });
        continue;
      }
      const full = revParse(dir, s);
      if (!full) {
        unverified.push({ sha: s, id: node.id, source: "commits-field", reason: "unknown-object" });
        continue;
      }
      const onTip = isAncestor(dir, full, resolved.tip);
      if (onTip !== true) {
        if (onTip === null) unverified.push({ sha: s, id: node.id, source: "commits-field", reason: "git-error" });
        continue; // false: not landed (yet) — the ordinary branch-only case
      }
      const subj = git(dir, ["log", "-1", "--format=%s", full]);
      stamped.set(s, { sha: full, subject: ok(subj) ? String(subj.stdout || "").trim() : "" });
    }
  }
  return { ref: resolved.ref, tip: resolved.tip, since: sinceSha, trailered, stamped, unverified };
}

module.exports = { DEFAULT_REFS, DEFAULT_LAST, resolveRef, isAncestor, scanTrailers, collect };
