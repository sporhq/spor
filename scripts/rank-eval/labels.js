"use strict";
// Recover per-node relevance labels from the digest-intent eval corpus
// (art-spor-digest-noise-eval-2026-06-25, preserved in the private server repo
// at evals/digest-intent-2026-07-06).
//
// THE JOIN. The judge recorded `node_relevance` as a POSITIONAL array — one
// label per digest line, with no node ids. The ids live in the digest text the
// judge was shown, so a label is only recoverable by re-parsing that text and
// zipping it against the array. Two arms were judged per case, in two different
// render formats:
//
//   arm A "actual"  — the digest the live SERVER injected, kept on the case
//                     record as `actual_digest`, in compile's full format
//                     (`- **id — title** (meta): summary`).
//   arm B "current" — the local replay of the repo engine, kept on the replay
//                     record as `candidate_digest`, in prompt-context's micro
//                     format (`- id: title — summary`).
//
// Both arms are labeled per (prompt, node), so their labels are poolable: the
// union is a wider candidate set than either arm alone (~7.6 nodes/case vs 5),
// which is what lets run.js reward a ranker for SURFACING a known-relevant node
// arm B missed, not merely for reordering arm B's five.
//
// A zip is only trustworthy when the parsed line count equals the label count.
// The judge occasionally returned more labels than the digest had lines, and
// `cases.jsonl` was re-extracted after the judge ran (21 of the 150 judged cases
// lost their prompt, which the harness needs to re-run the engine). Every such
// case is DROPPED rather than truncated to fit — a silently misaligned label is
// worse than a missing one. `buildPool` reports each drop reason so the usable
// set is auditable instead of implicit.

const fs = require("fs");
const path = require("path");

const readJsonl = (file) =>
  fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

// Digest line -> node id, for each of the two render formats. Anchored at line
// start so an id mentioned inside a summary can't be picked up as a slot.
const microIds = (text) => [...(text ?? "").matchAll(/^- ([a-z0-9][a-z0-9-]*):/gm)].map((m) => m[1]);
const fullIds = (text) => [...(text ?? "").matchAll(/^- \*\*([a-z0-9][a-z0-9-]*) — /gm)].map((m) => m[1]);

// Zip ids to labels, or null when the counts disagree (see above).
function zip(ids, labels) {
  if (!ids.length || !labels?.length || ids.length !== labels.length) return null;
  return ids.map((id, i) => [id, labels[i]]);
}

// Build the labeled evaluation set from an eval directory.
//
// Returns { cases, stats }. Each case carries what run.js needs to re-run the
// engine at the right point in graph time (prompt, project_slug, snap_sha) plus
// `labels` (id -> relevance) and `baselineOrder` (arm B's order, the shipped
// ranker's own output at label time — the before-picture the report compares
// against).
function buildPool(dir) {
  const judge = readJsonl(path.join(dir, "out", "judge-actual-vs-current.jsonl"));
  const replay = new Map(readJsonl(path.join(dir, "out", "replay-current.jsonl")).map((r) => [r.case_id, r]));
  const cases = new Map(readJsonl(path.join(dir, "cases", "cases.jsonl")).map((c) => [c.case_id, c]));

  const out = [];
  const stats = { judged: judge.length, noPrompt: 0, noReplay: 0, misaligned: 0, noLabels: 0, agree: 0, conflict: 0 };

  for (const j of judge) {
    const c = cases.get(j.case_id);
    const r = replay.get(j.case_id);
    if (!c) { stats.noPrompt++; continue; } // re-extraction casualty
    if (!r) { stats.noReplay++; continue; }

    const b = zip(microIds(r.candidate_digest), j.b?.node_relevance);
    const a = zip(fullIds(c.actual_digest), j.a?.node_relevance);
    if (!b && !a) {
      // Both arms empty is an honest "no digest fired, nothing to rank"; a
      // count disagreement is a real misalignment. Distinguish them.
      const emptyBoth = !j.b?.node_relevance?.length && !j.a?.node_relevance?.length;
      if (emptyBoth) stats.noLabels++; else stats.misaligned++;
      continue;
    }

    const labels = {};
    for (const [id, l] of b ?? []) labels[id] = l;
    for (const [id, l] of a ?? []) {
      // Where the arms overlap, keep arm B's label and count the (dis)agreement
      // — the judge scored the same (prompt, node) twice, so the rate is a free
      // check on both judge consistency and this positional join.
      if (labels[id] != null) { if (labels[id] === l) stats.agree++; else stats.conflict++; continue; }
      labels[id] = l;
    }

    out.push({
      case_id: j.case_id,
      project_slug: c.project_slug,
      prompt: c.prompt,
      snap_sha: r.snap_sha,
      warranted: j.warranted,
      labels,
      baselineOrder: (b ?? []).map(([id]) => id),
    });
  }
  return { cases: out, stats };
}

module.exports = { buildPool, microIds, fullIds, zip };
