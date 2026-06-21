// kernel/analytics.js — pure work-analytics fold over the git-derived timestamp
// index (task-spor-work-analytics-consumer, dec-spor-git-derived-timestamps).
// Data in, data out (REFACTOR.md §1): no filesystem, no git spawn, no clock —
// `now` is injected. The shell half (lib/shell/gittime.js) runs `git log -p` and
// reads the cache; this module only PARSES that log, folds each node's status
// timeline into a completion time, and aggregates created-vs-completed cohorts.
//
// The hard constraint (dec-spor-git-derived-timestamps): a node's COMPLETION time
// must be its status-TRANSITION time (when it first entered its final terminal
// run), NOT updated_at — a later edge append moves updated_at past completion and
// corrupts the "completed last week" signal. We derive that transition time from
// the git CONTENT history of the `status:` line; supersession (which leaves the
// node's own status untouched) falls back to the superseding node's created_at,
// and a graph with no git history falls back to created_at. updated_at is never
// used as a completion proxy. Plain Node, zero deps.
//
// Exports:
//   foldStatusTransitions(logText, nodesName, isTerminal) -> { id: closedAtISO }
//   computeAnalytics(opts)                                 -> report object
//   isoWeekKey(ms) / weekStartUTC(ms)                      -> week bucketing helpers

"use strict";

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const parse = (iso) => (iso == null ? NaN : Date.parse(iso));
const DAY = 86400000;
const WEEK = 7 * DAY;

// Parse `git log --reverse --no-renames --format=%x01%ct -p --diff-filter=ACMR
// -- <nodesName>/` (OLDEST commit first) into { id: closedAtISO } for every node
// whose FINAL committed `status:` is terminal. closedAtISO is the committer time
// of the commit that BEGAN that final terminal run (the transition INTO terminal
// the node still sits in) — so a done→reopened→done node reports its latest
// closure, and a done→merged node keeps the original done time (the run never
// left terminal). A node whose final status is non-terminal (or never set) is
// absent (it isn't completed). Pure: git emits the bytes, we only fold them.
//
// Each commit is a `\x01<epoch>` marker line then the unified patch. Within a
// file (a `+++ b/<nodesName>/<id>.md` header), an added `+status: X` line is the
// new status after that commit; a `-status:` with no paired add clears it. A
// commit that doesn't touch the status line emits neither, so the status carries
// forward unchanged. (A body line literally beginning `status:` would also match;
// node bodies effectively never do, mirroring the path-only fold in timestamps.js.)
function foldStatusTransitions(logText, nodesName = "nodes", isTerminal = () => false) {
  if (!logText) return {};
  const fileRe = new RegExp(`^\\+\\+\\+ b/${reEsc(nodesName)}/([a-z0-9][a-z0-9-]*)\\.md$`);
  // Per-node forward-walk state: the current status, whether it's terminal, and
  // the time the current terminal run began (null when not in a terminal run).
  const st = {}; // id -> { status, terminal, runStart }
  let t = null;          // current commit time (ms)
  let file = null;       // current node id within the patch, or null
  let added = null;      // last `+status:` value seen in this file's hunk
  let removed = false;   // a `-status:` was seen in this file's hunk

  // Apply the (added/removed) status delta accumulated for `file` at time `t`.
  const flushFile = () => {
    if (file == null) return;
    let next;
    if (added != null) next = added;        // an explicit new value
    else if (removed) next = null;          // status line deleted -> cleared
    else { file = null; added = null; removed = false; return; } // unchanged this commit
    const cur = st[file] || { status: null, terminal: false, runStart: null };
    const term = next != null && isTerminal(next);
    if (term && !cur.terminal) cur.runStart = t;   // entering a terminal run
    else if (!term) cur.runStart = null;           // left terminal
    // term && cur.terminal: still terminal (done->merged) -> keep the run start
    cur.status = next;
    cur.terminal = term;
    st[file] = cur;
    file = null; added = null; removed = false;
  };

  for (const raw of logText.split("\n")) {
    if (raw.charCodeAt(0) === 1) {            // \x01<epoch> commit marker
      flushFile();
      t = Number(raw.slice(1)) * 1000;
      continue;
    }
    // A unified-diff new-file header (`+++ b/<path>` or `+++ /dev/null`) ALWAYS
    // ends the current file's accumulation — even when the path is NOT a
    // conforming node id — so a stray non-canonical `nodes/*.md` (a README, a
    // node whose id breaks the kebab regex) can't bleed its ±status lines into
    // the previously parsed node. `file` is set only for a real
    // b/<nodesName>/<id>.md header; anything else (a non-node path, /dev/null, or
    // a `++ x` body line that renders as `+++ x`) resets it to null.
    if (raw[0] === "+" && raw[1] === "+" && raw[2] === "+" && raw[3] === " ") {
      flushFile();
      const m = fileRe.exec(raw);
      file = m ? m[1] : null;
      added = null; removed = false;
      continue;
    }
    if (file == null) continue;
    if (raw[0] === "+" && raw[1] !== "+") {
      const sm = /^\+status:\s*(.*?)\s*$/.exec(raw);
      if (sm) added = sm[1] || "";
    } else if (raw[0] === "-" && raw[1] !== "-") {
      if (/^-status:/.test(raw)) removed = true;
    }
  }
  flushFile();

  const out = {};
  for (const id of Object.keys(st)) {
    const s = st[id];
    if (s.terminal && s.runStart != null) out[id] = new Date(s.runStart).toISOString();
  }
  return out;
}

// Monday 00:00:00 UTC of the week containing `ms` (ISO weeks start Monday).
function weekStartUTC(ms) {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY;
}

// ISO-8601 week label "YYYY-Www" (week-year may differ from calendar year near
// the boundary). The Thursday of the week determines the week-year.
function isoWeekKey(ms) {
  const d = new Date(ms);
  const thu = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  thu.setUTCDate(thu.getUTCDate() - ((thu.getUTCDay() + 6) % 7) + 3); // Thursday of this week
  const weekYear = thu.getUTCFullYear();
  const firstThu = new Date(Date.UTC(weekYear, 0, 4)); // Jan 4 is always in week 1
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((thu - firstThu) / WEEK);
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

function median(sorted) {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// computeAnalytics(opts) -> report. All inputs are DATA (the façade resolves git
// + the graph and injects them), so the fold is deterministic and testable.
//   nodes        : { id: node }              — graph.nodes (type/status/title)
//   timestamps   : { id: {created_at,...} }  — graph.timestamps (override-applied) or null
//   gitClosed    : { id: closedAtISO }       — foldStatusTransitions result (may be {})
//   supersededBy : { id: supersederId }      — graph.supersededBy
//   isTerminal   : (status) => boolean       — registry/resolution terminal test
//   now          : ms                        — injected clock
//   weeks        : int (default 12)          — window length for the weekly table
//   typeSet      : Set<string> | null        — restrict to these node types
//   inScope      : (node) => boolean | null  — project-scope filter (null = all)
//   agingDays    : int (default 30)          — "aging WIP" / bottleneck age threshold
//   topN         : int (default 10)          — bottleneck list length
function computeAnalytics(opts = {}) {
  const {
    nodes = {}, timestamps = null, gitClosed = {}, supersededBy = {},
    isTerminal = () => false, now = Date.now(), weeks = 12,
    typeSet = null, inScope = null, agingDays = 30, topN = 10,
  } = opts;

  const createdOf = (id, node) => {
    const t = timestamps && timestamps[id];
    return parse((t && t.created_at) || node.created_at || node.date || null);
  };
  // Completion truth for a RETIRED node (terminal status or superseded), high-first:
  //   1. git status-transition time (the constraint's primary signal);
  //   2. the superseding node's created_at (supersession leaves status untouched,
  //      so it has no transition of its own — the replacement's birth is the
  //      moment it was retired);
  //   3. its own created_at (born terminal, or git history squashed away).
  // updated_at is deliberately never consulted.
  const completionOf = (id, node) => {
    const g = gitClosed[id];
    if (g) return { at: parse(g), source: "git" };
    const sup = supersededBy[id];
    if (sup) {
      const st = timestamps && timestamps[sup];
      if (st && st.created_at) return { at: parse(st.created_at), source: "superseded" };
    }
    const c = createdOf(id, node);
    if (!Number.isNaN(c)) return { at: c, source: "created" };
    return null;
  };

  const considered = [];
  for (const node of Object.values(nodes)) {
    if (typeSet && !typeSet.has(node.type)) continue;
    if (inScope && !inScope(node)) continue;
    const id = node.id;
    const retired = isTerminal(node.status) || !!supersededBy[id];
    const created = createdOf(id, node);
    const comp = retired ? completionOf(id, node) : null;
    considered.push({
      id, type: node.type, status: node.status || null, title: node.title || node.summary || id,
      created: Number.isNaN(created) ? null : created,
      closed: comp ? comp.at : null,
      closedSource: comp ? comp.source : null,
      live: !retired,
    });
  }

  // Weekly cohorts over the last `weeks` weeks, oldest -> newest. created and
  // completed are bucketed by week; backlog is the open count AT each week's end
  // (created on/before the boundary, not yet completed by it) — the WIP curve,
  // which by construction includes work created before the window.
  const curWeekStart = weekStartUTC(now);
  const windowStart = curWeekStart - (weeks - 1) * WEEK;
  const weekly = [];
  for (let i = 0; i < weeks; i++) {
    const from = windowStart + i * WEEK;
    const to = from + WEEK;
    let created = 0, completed = 0, backlog = 0;
    for (const it of considered) {
      if (it.created != null && it.created >= from && it.created < to) created++;
      if (it.closed != null && it.closed >= from && it.closed < to) completed++;
      if (it.created != null && it.created < to && (it.closed == null || it.closed >= to)) backlog++;
    }
    weekly.push({ week: isoWeekKey(from), from: isoDate(from), to: isoDate(to - DAY), created, completed, net: created - completed, backlog });
  }

  // Window totals + cycle time for items COMPLETED within the window.
  const windowEnd = curWeekStart + WEEK;
  let createdTot = 0, completedTot = 0, gitTransitions = 0, fallbackCompletions = 0;
  const cycleDays = [];
  for (const it of considered) {
    if (it.created != null && it.created >= windowStart && it.created < windowEnd) createdTot++;
    if (it.closed != null && it.closed >= windowStart && it.closed < windowEnd) {
      completedTot++;
      if (it.created != null && it.closed >= it.created) cycleDays.push((it.closed - it.created) / DAY);
      if (it.closedSource === "git") gitTransitions++; else fallbackCompletions++;
    }
  }
  cycleDays.sort((a, b) => a - b);

  // Current WIP (live nodes), by type, plus aging WIP and the oldest-open
  // bottleneck list — the "where is work piling up" view.
  const live = considered.filter((it) => it.live);
  const byType = {};
  for (const it of live) byType[it.type] = (byType[it.type] || 0) + 1;
  const aged = live.filter((it) => it.created != null && (now - it.created) / DAY >= agingDays);
  const bottlenecks = live
    .filter((it) => it.created != null)
    .sort((a, b) => a.created - b.created)
    .slice(0, topN)
    .map((it) => ({ id: it.id, type: it.type, status: it.status, ageDays: Math.floor((now - it.created) / DAY), title: it.title }));

  return {
    window: { weeks, fromWeek: isoWeekKey(windowStart), toWeek: isoWeekKey(curWeekStart), now: new Date(now).toISOString() },
    weekly,
    totals: { created: createdTot, completed: completedTot, net: createdTot - completedTot },
    throughput: { perWeek: Math.round((completedTot / weeks) * 100) / 100 },
    cycleTimeDays: {
      count: cycleDays.length,
      median: median(cycleDays) == null ? null : Math.round(median(cycleDays) * 10) / 10,
      p90: percentile(cycleDays, 90) == null ? null : Math.round(percentile(cycleDays, 90) * 10) / 10,
    },
    wip: { open: live.length, aging: aged.length, agingDays, byType },
    bottlenecks,
    coverage: {
      nodesConsidered: considered.length,
      completedInWindow: completedTot,
      fromGitTransition: gitTransitions,
      fromFallback: fallbackCompletions,
      hasTimestamps: !!timestamps,
    },
  };
}

module.exports = { foldStatusTransitions, computeAnalytics, isoWeekKey, weekStartUTC };
