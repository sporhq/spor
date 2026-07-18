// Work-analytics consumer (task-spor-work-analytics-consumer,
// dec-spor-git-derived-timestamps). Two layers:
//   1. the PURE kernel (lib/kernel/analytics.js) — the git-content status-timeline
//      fold, the ISO-week math, and the created-vs-completed aggregation, all data
//      in / data out, no git;
//   2. the façade (lib/analytics.js) over a real scratch git repo — completion
//      time as the status-TRANSITION time (NOT updated_at), the supersession and
//      created_at fallbacks, project scoping, and the non-git degradation.

require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const k = require("../lib/kernel/analytics.js");
const analyticsLib = require("../lib/analytics.js");
const graphLib = require("../lib/graph.js");
const resolution = require("../lib/kernel/resolution.js");

const isTerm = resolution.isTerminalStatus;
const DAY = 86400000;
const WEEK = 7 * DAY;

// ---------- pure kernel: foldStatusTransitions ----------

// A synthetic `git log --reverse --format=%x01%ct -p` stream (OLDEST first).
const C = (epoch) => "\x01" + epoch;
const create = (id, status, epoch) => [
  C(epoch), `diff --git a/nodes/${id}.md b/nodes/${id}.md`, "new file mode 100644",
  "--- /dev/null", `+++ b/nodes/${id}.md`, "@@ -0,0 +1,2 @@", `+id: ${id}`, `+status: ${status}`,
];
const change = (id, from, to, epoch) => [
  C(epoch), `diff --git a/nodes/${id}.md b/nodes/${id}.md`,
  `--- a/nodes/${id}.md`, `+++ b/nodes/${id}.md`, "@@ -2 +2 @@", `-status: ${from}`, `+status: ${to}`,
];

test("foldStatusTransitions: closed_at = the commit that ENTERED the final terminal run", () => {
  const log = [...create("task-a", "open", 1700000000), ...change("task-a", "open", "done", 1701000000)].join("\n");
  const out = k.foldStatusTransitions(log, "nodes", isTerm);
  assert.equal(out["task-a"], new Date(1701000000 * 1000).toISOString());
});

test("foldStatusTransitions: done→merged keeps the original done time (run never left terminal)", () => {
  const log = [
    ...create("task-a", "open", 1700000000),
    ...change("task-a", "open", "done", 1701000000),
    ...change("task-a", "done", "merged", 1702000000), // still terminal
  ].join("\n");
  assert.equal(k.foldStatusTransitions(log, "nodes", isTerm)["task-a"], new Date(1701000000 * 1000).toISOString());
});

test("foldStatusTransitions: reopen (done→open→done) reports the LATEST closure", () => {
  const log = [
    ...create("task-a", "open", 1700000000),
    ...change("task-a", "open", "done", 1700100000),
    ...change("task-a", "done", "open", 1700200000), // reopened -> run reset
    ...change("task-a", "open", "done", 1700300000), // reclosed
  ].join("\n");
  assert.equal(k.foldStatusTransitions(log, "nodes", isTerm)["task-a"], new Date(1700300000 * 1000).toISOString());
});

test("foldStatusTransitions: a node whose final status is non-terminal is absent", () => {
  const log = [
    ...create("task-a", "open", 1700000000),
    ...change("task-a", "open", "done", 1700100000),
    ...change("task-a", "done", "open", 1700200000), // ends open
  ].join("\n");
  assert.ok(!("task-a" in k.foldStatusTransitions(log, "nodes", isTerm)));
});

test("foldStatusTransitions: empty / null input -> empty map", () => {
  assert.deepEqual(k.foldStatusTransitions("", "nodes", isTerm), {});
  assert.deepEqual(k.foldStatusTransitions(null, "nodes", isTerm), {});
});

// ---------- pure kernel: state seeding + range composition (the cache invariant) ----------

test("foldStatusTransitionState: seeding a range onto a base == folding the full history", () => {
  // A reopen straddling the cache boundary: done at the base head, then
  // reopened→reclosed in the incremental range — the trickiest composition.
  const base = [...create("task-a", "open", 1700000000), ...change("task-a", "open", "done", 1700100000)];
  const range = [
    ...change("task-a", "done", "open", 1700200000),   // reopened in the new commits
    ...change("task-a", "open", "done", 1700300000),    // reclosed
  ];
  const baseState = k.foldStatusTransitionState(base.join("\n"), "nodes", isTerm);
  const incr = k.statusTransitionsFromState(
    k.foldStatusTransitionState(range.join("\n"), "nodes", isTerm, baseState));
  const full = k.foldStatusTransitions([...base, ...range].join("\n"), "nodes", isTerm);
  assert.deepEqual(incr, full);
  assert.equal(incr["task-a"], new Date(1700300000 * 1000).toISOString()); // latest closure
});

test("foldStatusTransitionState: done→merged across the boundary keeps the original run start", () => {
  const base = [...create("task-a", "open", 1700000000), ...change("task-a", "open", "done", 1700100000)];
  const range = change("task-a", "done", "merged", 1700200000); // still terminal -> run unbroken
  const baseState = k.foldStatusTransitionState(base.join("\n"), "nodes", isTerm);
  const incr = k.statusTransitionsFromState(
    k.foldStatusTransitionState(range.join("\n"), "nodes", isTerm, baseState));
  assert.equal(incr["task-a"], new Date(1700100000 * 1000).toISOString()); // the done time, not merged
});

test("foldStatusTransitionState: an empty range leaves the seeded base untouched (and unmutated)", () => {
  const base = [...create("task-a", "open", 1700000000), ...change("task-a", "open", "done", 1700100000)];
  const baseState = k.foldStatusTransitionState(base.join("\n"), "nodes", isTerm);
  const before = JSON.stringify(baseState);
  const incr = k.foldStatusTransitionState("", "nodes", isTerm, baseState); // no new commits
  assert.deepEqual(k.statusTransitionsFromState(incr), { "task-a": new Date(1700100000 * 1000).toISOString() });
  assert.equal(JSON.stringify(baseState), before); // the cached base object is never mutated
});

test("statusTransitionsFromState: only nodes in a terminal run with a runStart appear", () => {
  const st = {
    "task-done": { status: "done", terminal: true, runStart: 1700000000000 },
    "task-open": { status: "open", terminal: false, runStart: null },
  };
  assert.deepEqual(k.statusTransitionsFromState(st), { "task-done": new Date(1700000000000).toISOString() });
});

test("foldStatusTransitions: born terminal (created already done) -> created commit time", () => {
  const log = create("art-x", "done", 1700500000).join("\n");
  assert.equal(k.foldStatusTransitions(log, "nodes", isTerm)["art-x"], new Date(1700500000 * 1000).toISOString());
});

test("foldStatusTransitions: a stray non-conforming nodes/*.md can't leak status into a real node", () => {
  // One commit touches aaa (a real node, status unchanged -> stays open) THEN a
  // non-canonically-named file z.bad.md flipping its own status to open. The
  // z.bad header must reset the active file so its `+status: open` can't be
  // attributed to aaa (which would falsely report aaa terminal/non-terminal).
  const log = [
    ...create("aaa", "done", 1700000000),                 // aaa born done -> terminal
    C(1700100000),
    "diff --git a/nodes/aaa.md b/nodes/aaa.md",
    "--- a/nodes/aaa.md", "+++ b/nodes/aaa.md",
    "@@ -3 +3 @@", " context only, status line untouched", "+a body line",
    "diff --git a/nodes/z.bad.md b/nodes/z.bad.md",        // NON-conforming id
    "--- a/nodes/z.bad.md", "+++ b/nodes/z.bad.md",
    "@@ -2 +2 @@", "-status: active", "+status: open",
  ].join("\n");
  const out = k.foldStatusTransitions(log, "nodes", isTerm);
  assert.equal(out["aaa"], new Date(1700000000 * 1000).toISOString()); // aaa stays done@birth
  assert.ok(!("z.bad" in out));                                         // stray file never tracked
});

// ---------- pure kernel: week math ----------

test("isoWeekKey / weekStartUTC: ISO weeks start Monday", () => {
  assert.equal(k.isoWeekKey(Date.parse("2026-01-01T00:00:00Z")), "2026-W01");
  // 2026-06-17 is a Wednesday -> week starts Monday 2026-06-15
  assert.equal(new Date(k.weekStartUTC(Date.parse("2026-06-17T12:00:00Z"))).toISOString(), "2026-06-15T00:00:00.000Z");
  // a Monday maps to itself
  assert.equal(new Date(k.weekStartUTC(Date.parse("2026-06-15T00:00:00Z"))).toISOString(), "2026-06-15T00:00:00.000Z");
});

// ---------- pure kernel: computeAnalytics ----------

test("computeAnalytics: created/completed cohorts + net + backlog curve", () => {
  const now = Date.parse("2026-06-21T00:00:00Z");
  const mon = k.weekStartUTC(now); // Mon 2026-06-15
  const nodes = {
    "task-1": { id: "task-1", type: "task", status: "done", title: "T1" },
    "task-2": { id: "task-2", type: "task", status: "open", title: "T2" },
  };
  const timestamps = {
    "task-1": { created_at: new Date(mon - WEEK + DAY).toISOString(), updated_at: "z" }, // created in W24
    "task-2": { created_at: new Date(mon - 3 * WEEK).toISOString(), updated_at: "z" },   // old, still open
  };
  const gitClosed = { "task-1": new Date(mon - DAY).toISOString() }; // completed in W24
  const r = k.computeAnalytics({ nodes, timestamps, gitClosed, supersededBy: {}, isTerminal: isTerm, now, weeks: 6 });
  assert.equal(r.totals.created, 2);
  assert.equal(r.totals.completed, 1);
  assert.equal(r.totals.net, 1);
  // task-1 created Tue and closed the next Sun -> both land in W24
  const w24 = r.weekly.find((w) => w.week === "2026-W24");
  assert.equal(w24.created, 1);
  assert.equal(w24.completed, 1);
  // backlog at the latest week = the one still-open node
  assert.equal(r.weekly[r.weekly.length - 1].backlog, 1);
  // cycle time only counts the one completed item (~6 days)
  assert.equal(r.cycleTimeDays.count, 1);
  assert.equal(r.coverage.fromGitTransition, 1);
  assert.equal(r.coverage.fromFallback, 0);
});

test("computeAnalytics: a superseded node completes at the SUPERSEDER's created_at (status fallback)", () => {
  const now = Date.parse("2026-06-21T00:00:00Z");
  const mon = k.weekStartUTC(now);
  const nodes = { "dec-old": { id: "dec-old", type: "decision", status: "open", title: "old" } }; // status never flipped
  const timestamps = {
    "dec-old": { created_at: new Date(mon - 4 * WEEK).toISOString(), updated_at: "z" },
    "dec-new": { created_at: new Date(mon - DAY).toISOString(), updated_at: "z" }, // replacement, last week
  };
  const r = k.computeAnalytics({
    nodes, timestamps, gitClosed: {}, supersededBy: { "dec-old": "dec-new" },
    isTerminal: isTerm, now, weeks: 6,
  });
  assert.equal(r.totals.completed, 1);
  assert.equal(r.coverage.fromFallback, 1);      // not a git status-transition
  assert.equal(r.coverage.fromGitTransition, 0);
  // its completion lands in the superseder's week, not its own creation week
  const completedWeek = r.weekly.find((w) => w.completed > 0).week;
  assert.equal(completedWeek, k.isoWeekKey(mon - DAY));
});

test("computeAnalytics: a node retired by a resolves/answers edge (status lags open) completes at the RESOLVER's created_at", () => {
  // task-spor-analytics-resolution-edge-completion: status still reads open, but a
  // live resolver points at it — count it completed, not WIP, dated at the resolver.
  const now = Date.parse("2026-06-21T00:00:00Z");
  const mon = k.weekStartUTC(now);
  const nodes = { "task-lag": { id: "task-lag", type: "task", status: "open", title: "lagging" } };
  const timestamps = {
    "task-lag": { created_at: new Date(mon - 4 * WEEK).toISOString(), updated_at: "z" },
    "art-fix": { created_at: new Date(mon - DAY).toISOString(), updated_at: "z" }, // resolver, last week
  };
  const r = k.computeAnalytics({
    nodes, timestamps, gitClosed: {}, supersededBy: {}, resolvedBy: { "task-lag": "art-fix" },
    isTerminal: isTerm, now, weeks: 6,
  });
  assert.equal(r.totals.completed, 1);
  assert.equal(r.wip.open, 0);                       // no longer counted as WIP
  assert.equal(r.bottlenecks.length, 0);             // and out of the bottleneck list
  assert.equal(r.coverage.fromResolutionEdge, 1);
  assert.equal(r.coverage.fromFallback, 1);          // resolution edge IS a fallback (no own git transition)
  assert.equal(r.coverage.fromGitTransition, 0);
  // its completion lands in the resolver's week, not its own creation week
  assert.equal(r.weekly.find((w) => w.completed > 0).week, k.isoWeekKey(mon - DAY));
});

test("computeAnalytics: a node's own git status-transition wins over a resolution edge", () => {
  // A node that DID flip terminal keeps its git transition time — the resolver
  // edge never moves an already-git-dated completion (precedence guard).
  const now = Date.parse("2026-06-21T00:00:00Z");
  const mon = k.weekStartUTC(now);
  const nodes = { "task-d": { id: "task-d", type: "task", status: "done", title: "done" } };
  const timestamps = {
    "task-d": { created_at: new Date(mon - 4 * WEEK).toISOString(), updated_at: "z" },
    "art-fix": { created_at: new Date(mon - 3 * WEEK).toISOString(), updated_at: "z" }, // resolver born earlier
  };
  const gitClosed = { "task-d": new Date(mon - DAY).toISOString() }; // own transition last week
  const r = k.computeAnalytics({
    nodes, timestamps, gitClosed, supersededBy: {}, resolvedBy: { "task-d": "art-fix" },
    isTerminal: isTerm, now, weeks: 6,
  });
  assert.equal(r.coverage.fromGitTransition, 1);
  assert.equal(r.coverage.fromResolutionEdge, 0);
  // completion lands in the git-transition week, not the (earlier) resolver's week
  assert.equal(r.weekly.find((w) => w.completed > 0).week, k.isoWeekKey(mon - DAY));
});

test("computeAnalytics: type filter + WIP-by-type + bottlenecks (oldest open first)", () => {
  const now = Date.parse("2026-06-21T00:00:00Z");
  const mon = k.weekStartUTC(now);
  const nodes = {
    "task-old": { id: "task-old", type: "task", status: "open", title: "oldest" },
    "task-new": { id: "task-new", type: "task", status: "open", title: "newer" },
    "norm-x": { id: "norm-x", type: "norm", status: "open", title: "a norm" },
  };
  const timestamps = {
    "task-old": { created_at: new Date(mon - 40 * DAY).toISOString(), updated_at: "z" },
    "task-new": { created_at: new Date(mon - 2 * DAY).toISOString(), updated_at: "z" },
    "norm-x": { created_at: new Date(mon - 10 * DAY).toISOString(), updated_at: "z" },
  };
  const r = k.computeAnalytics({
    nodes, timestamps, gitClosed: {}, supersededBy: {}, isTerminal: isTerm, now, weeks: 12,
    typeSet: new Set(["task"]), agingDays: 30,
  });
  assert.equal(r.wip.open, 2);                 // norm-x filtered out
  assert.deepEqual(r.wip.byType, { task: 2 });
  assert.equal(r.wip.aging, 1);                // only task-old is ≥30d
  assert.equal(r.bottlenecks[0].id, "task-old"); // oldest open first
  assert.ok(r.bottlenecks[0].ageDays >= 40);
});

// ---------- integration: the façade over a real scratch git repo ----------

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), "spor-an-")); }
function git(dir, ...args) { execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" }); }
function initGraph() {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, "nodes"));
  git(home, "init", "-q");
  git(home, "config", "user.email", "t@t");
  git(home, "config", "user.name", "t");
  return home;
}
function writeNode(home, id, type, status, extra = "", date = "2026-01-01") {
  const statusLine = status == null ? "" : `status: ${status}\n`;
  fs.writeFileSync(path.join(home, "nodes", `${id}.md`),
    `---\nid: ${id}\ntype: ${type}\ntitle: ${id}\nsummary: ${id} summary.\n${statusLine}date: ${date}\n${extra}---\nbody\n`);
}
function commit(home, when, msg) {
  git(home, "add", "-A");
  execFileSync("git", ["-C", home, "commit", "-q", "-m", msg],
    { stdio: "ignore", env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when } });
}

test("analyze: completion is the status-TRANSITION commit, immune to a later edge append", () => {
  const home = initGraph();
  writeNode(home, "task-a", "task", "open");
  commit(home, "2026-05-04T00:00:00Z", "create A open");      // Mon W19
  writeNode(home, "task-a", "task", "done");
  commit(home, "2026-05-11T00:00:00Z", "close A");            // Mon W20 — the transition
  // a LATER edge append moves updated_at forward but must NOT move completion
  fs.appendFileSync(path.join(home, "nodes", "task-a.md"), "\nextra line appended later\n");
  commit(home, "2026-06-01T00:00:00Z", "append to A");        // updated_at, NOT completion

  const g = graphLib.loadGraph(path.join(home, "nodes"));
  const now = Date.parse("2026-06-21T00:00:00Z");
  const r = analyticsLib.analyze(g, { now, weeks: 12 });
  // updated_at advanced to June, but the completion week is W20 (the close)
  assert.equal(g.timestamps["task-a"].updated_at, new Date("2026-06-01T00:00:00Z").toISOString());
  const completedWeek = r.weekly.find((w) => w.completed > 0);
  assert.equal(completedWeek.week, "2026-W20");
  assert.equal(r.coverage.fromGitTransition, 1);
  assert.equal(r.coverage.fromFallback, 0);
});

test("analyze: created cohort and a still-open node count as WIP, not completed", () => {
  const home = initGraph();
  writeNode(home, "task-open", "task", "open");
  commit(home, "2026-06-01T00:00:00Z", "create open task");
  writeNode(home, "task-done", "task", "open");
  commit(home, "2026-06-02T00:00:00Z", "create done task");
  writeNode(home, "task-done", "task", "done");
  commit(home, "2026-06-08T00:00:00Z", "close done task");

  const g = graphLib.loadGraph(path.join(home, "nodes"));
  const r = analyticsLib.analyze(g, { now: Date.parse("2026-06-21T00:00:00Z"), weeks: 12 });
  assert.equal(r.totals.created, 2);
  assert.equal(r.totals.completed, 1);
  assert.equal(r.wip.open, 1);
  assert.equal(r.bottlenecks[0].id, "task-open");
});

test("analyze: --type / typeSet restricts the cohorts", () => {
  const home = initGraph();
  writeNode(home, "task-1", "task", "open");
  writeNode(home, "issue-1", "issue", "open");
  commit(home, "2026-06-01T00:00:00Z", "create two");
  const g = graphLib.loadGraph(path.join(home, "nodes"));
  const all = analyticsLib.analyze(g, { now: Date.parse("2026-06-21T00:00:00Z") });
  const tasksOnly = analyticsLib.analyze(g, { now: Date.parse("2026-06-21T00:00:00Z"), types: ["task"] });
  assert.equal(all.wip.open, 2);
  assert.equal(tasksOnly.wip.open, 1);
  assert.deepEqual(tasksOnly.wip.byType, { task: 1 });
});

test("analyze: non-git home degrades to frontmatter dates (no throw)", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, "nodes"));
  writeNode(home, "task-a", "task", "done", "", "2026-06-10"); // a date inside the window
  const g = graphLib.loadGraph(path.join(home, "nodes"));
  assert.equal(g.timestamps, null); // non-git -> no index
  const r = analyticsLib.analyze(g, { now: Date.parse("2026-06-21T00:00:00Z"), weeks: 12 });
  assert.equal(r.coverage.hasTimestamps, false);
  // the done node still completes — via the created_at/.date fallback, never updated_at
  assert.equal(r.totals.completed, 1);
  assert.equal(r.coverage.fromFallback, 1);
});

test("analyze: a resolves edge retires an open target — completed at the resolver's created_at, out of WIP", () => {
  // task-spor-analytics-resolution-edge-completion: task-lag's status never flips,
  // but an artifact resolves it — count it completed (in the resolver's week),
  // not as lingering WIP. The full façade → real-git → resolutionMap path.
  const home = initGraph();
  writeNode(home, "task-lag", "task", "open");
  commit(home, "2026-05-04T00:00:00Z", "create lagging task");                          // W19
  // an artifact that RESOLVES it, born last week — the task's own status stays open
  writeNode(home, "art-fix", "artifact", "done", "edges:\n  - {type: resolves, to: task-lag}\n");
  commit(home, "2026-06-15T00:00:00Z", "resolver lands");                               // W25

  const g = graphLib.loadGraph(path.join(home, "nodes"));
  const r = analyticsLib.analyze(g, { now: Date.parse("2026-06-21T00:00:00Z"), weeks: 12 });
  assert.equal(r.wip.open, 0);                                  // task-lag no longer lingers as WIP
  assert.ok(!r.bottlenecks.some((b) => b.id === "task-lag"));   // and out of the bottleneck list
  assert.equal(r.coverage.fromResolutionEdge, 1);              // task-lag, dated at the resolver
  assert.equal(r.coverage.fromGitTransition, 1);              // art-fix, born done
  // task-lag's completion lands in the resolver's week (W25), not its own creation week (W19)
  const w25 = r.weekly.find((w) => w.week === "2026-W25");
  assert.equal(w25.completed, 2);                              // both task-lag and art-fix
  // the human footnote names the status-lag completions
  const text = analyticsLib.renderReport(r);
  assert.match(text, /retired by a live resolves\/answers edge while status still lagged open/);
});

test("analyze: a decision settled via its schema-terminal status counts as completed, not WIP", () => {
  // issue-spor-analytics-completion-ignores-schema-terminal-status: `settled` is
  // terminal for a decision's OWN lifecycle (schema-decision status.terminal) but
  // deliberately ABSENT from resolution.js TERMINAL. Analytics unions the registry
  // partition with the legacy set, so a settled decision leaves WIP/bottlenecks and
  // lands in a completed cohort at its settle-transition commit — the hardcoded set
  // alone would strand it open forever.
  const home = initGraph();
  writeNode(home, "dec-x", "decision", "active");
  commit(home, "2026-05-04T00:00:00Z", "record decision");   // W19
  writeNode(home, "dec-x", "decision", "settled");
  commit(home, "2026-05-11T00:00:00Z", "settle decision");   // W20 — the transition

  const g = graphLib.loadGraph(path.join(home, "nodes"));
  assert.ok(g.registry.terminalStatuses().has("settled"), "seed schema-decision declares settled terminal");
  const r = analyticsLib.analyze(g, { now: NOW, weeks: 12 });
  assert.equal(r.totals.completed, 1);                       // settled = completed
  assert.equal(r.wip.open, 0);                               // not lingering WIP
  assert.ok(!r.bottlenecks.some((b) => b.id === "dec-x"));   // out of the oldest-open list
  assert.equal(r.coverage.fromGitTransition, 1);            // dated at the settle commit
  const completedWeek = r.weekly.find((w) => w.completed > 0);
  assert.equal(completedWeek.week, "2026-W20");
});

test("analyze: a non-artifact carrying `released` stays LIVE (type-aware, not the old flat union)", () => {
  // task-spor-analytics-type-aware-inert-partition: `released` is declared terminal
  // only on schema-artifact's OWN status.terminal. A mislabeled task carrying it
  // must NOT be silently counted complete — matching the type-aware queue.
  const home = initGraph();
  writeNode(home, "task-mislabeled", "task", "released");
  commit(home, "2026-05-04T00:00:00Z", "create mislabeled task");   // W19

  const g = graphLib.loadGraph(path.join(home, "nodes"));
  const r = analyticsLib.analyze(g, { now: NOW, weeks: 12 });
  assert.equal(r.totals.completed, 0);
  assert.equal(r.wip.open, 1);
  assert.ok(r.bottlenecks.some((b) => b.id === "task-mislabeled"));
});

test("analyze: an artifact `released` counts completed, dated at its OWN git status-transition", () => {
  // The type-aware counterpart of the above: for the type that DOES declare
  // `released` terminal, it must still complete — and with an accurate
  // git-transition date, not just a fallback (creation-date) one.
  const home = initGraph();
  writeNode(home, "art-shipped", "artifact", "in-review");
  commit(home, "2026-05-04T00:00:00Z", "create artifact in review");   // W19
  writeNode(home, "art-shipped", "artifact", "released");
  commit(home, "2026-05-11T00:00:00Z", "release artifact");            // W20 — the transition

  const g = graphLib.loadGraph(path.join(home, "nodes"));
  const r = analyticsLib.analyze(g, { now: NOW, weeks: 12 });
  assert.equal(r.totals.completed, 1);
  assert.equal(r.wip.open, 0);
  assert.ok(!r.bottlenecks.some((b) => b.id === "art-shipped"));
  assert.equal(r.coverage.fromGitTransition, 1);           // dated at the release commit, not a fallback
  const completedWeek = r.weekly.find((w) => w.completed > 0);
  assert.equal(completedWeek.week, "2026-W20");
});

test("renderReport: produces a stable human block with the cohort table + coverage", () => {
  const home = initGraph();
  writeNode(home, "task-a", "task", "open");
  commit(home, "2026-06-01T00:00:00Z", "create");
  writeNode(home, "task-a", "task", "done");
  commit(home, "2026-06-08T00:00:00Z", "close");
  const g = graphLib.loadGraph(path.join(home, "nodes"));
  const text = analyticsLib.renderReport(analyticsLib.analyze(g, { now: Date.parse("2026-06-21T00:00:00Z"), weeks: 4 }));
  assert.match(text, /Work analytics/);
  assert.match(text, /created\s+completed/);
  assert.match(text, /throughput:/);
  assert.match(text, /completion source: 1 git status-transition/);
});

// ---------- integration: the HEAD + terminal-vocabulary keyed closed-at cache ----------
// (task-spor-analytics-closed-at-cache) — mirrors the timestamps.json cache tests:
// cold write, exact-HEAD reuse (poison-proof), fast-forward == full, fp invalidation.

const NOW = Date.parse("2026-06-21T00:00:00Z");
const closedPath = (home) => path.join(home, "cache", "analytics-closed.json");
const readClosed = (home) => JSON.parse(fs.readFileSync(closedPath(home), "utf8"));
// The cache fingerprint is the analytics terminal vocabulary: the legacy
// type-blind kernel set plus a `<type>:<sorted values>` segment per node type
// declaring its OWN status.terminal (task-spor-analytics-type-aware-inert-
// partition) — mirroring lib/analytics.js's terminalFingerprint(), built here
// off the registry's per-type terminalStatuses(type) (not the flat no-arg
// registry.terminalStatuses() union, which can't distinguish a value moving
// between two types' declarations).
const FP = (() => {
  const reg = graphLib.seedRegistry();
  const types = [...reg.nodeSchemas.keys()].sort();
  const parts = [...resolution.terminalStatuses];
  for (const type of types) {
    const own = reg.terminalStatuses(type);
    if (own.size) parts.push(`${type}:${[...own].sort().join("|")}`);
  }
  return parts.join(",");
})();

// A graph with one task closed inside the 12-week window (W20, 2026-05-11).
function closedGraph() {
  const home = initGraph();
  writeNode(home, "task-a", "task", "open");
  commit(home, "2026-05-04T00:00:00Z", "open A");   // W19
  writeNode(home, "task-a", "task", "done");
  commit(home, "2026-05-11T00:00:00Z", "close A");  // W20 — the transition
  return home;
}

test("analyze: a cold run writes the HEAD + fp keyed status-transition cache", () => {
  const home = closedGraph();
  const g = graphLib.loadGraph(path.join(home, "nodes"));
  const r = analyticsLib.analyze(g, { now: NOW, weeks: 12 });
  assert.equal(r.coverage.fromGitTransition, 1);

  assert.ok(fs.existsSync(closedPath(home)));
  const c = readClosed(home);
  assert.equal(c.head, execFileSync("git", ["-C", home, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  assert.equal(c.fp, FP);                       // the terminal-vocabulary fingerprint
  assert.equal(c.state["task-a"].terminal, true); // the per-node fold STATE is cached, not the closed-at output
  assert.ok(c.state["task-a"].runStart > 0);
});

test("analyze: an exact-HEAD reload reuses the cache verbatim (no git log -p)", () => {
  const home = closedGraph();
  analyticsLib.analyze(graphLib.loadGraph(path.join(home, "nodes")), { now: NOW, weeks: 12 }); // seed
  // Poison the cached run start to a date OUTSIDE the window; an exact-HEAD hit
  // must reuse it (so the completion drops out of the window), proving no re-fold.
  const c = readClosed(home);
  c.state["task-a"].runStart = Date.parse("2020-01-01T00:00:00Z");
  fs.writeFileSync(closedPath(home), JSON.stringify(c));

  const r = analyticsLib.analyze(graphLib.loadGraph(path.join(home, "nodes")), { now: NOW, weeks: 12 });
  assert.equal(r.totals.completed, 0);          // it really used the poisoned cache
  assert.equal(r.coverage.fromGitTransition, 0);
});

test("analyze: a terminal-vocabulary fingerprint change forces a full rebuild", () => {
  const home = closedGraph();
  analyticsLib.analyze(graphLib.loadGraph(path.join(home, "nodes")), { now: NOW, weeks: 12 }); // seed
  // Poison BOTH the fp (stale vocabulary) and the state. A reuse would surface the
  // bogus runStart; a correct fp-driven rebuild ignores it and re-derives from git.
  const c = readClosed(home);
  c.fp = "stale-vocabulary";
  c.state["task-a"].runStart = Date.parse("2020-01-01T00:00:00Z");
  fs.writeFileSync(closedPath(home), JSON.stringify(c));

  const r = analyticsLib.analyze(graphLib.loadGraph(path.join(home, "nodes")), { now: NOW, weeks: 12 });
  assert.equal(r.totals.completed, 1);          // rebuilt from git, not the poisoned cache
  assert.equal(readClosed(home).fp, FP);        // cache re-keyed to the current vocabulary
});

test("analyze: a fast-forward incremental fold == a full rebuild (byte-identical report)", () => {
  const home = closedGraph();
  analyticsLib.analyze(graphLib.loadGraph(path.join(home, "nodes")), { now: NOW, weeks: 12 }); // seed cache at OLD head
  const oldHead = execFileSync("git", ["-C", home, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // New commits after the cached head: a reopen→reclose of A (run reset) + a brand-new closed node.
  writeNode(home, "task-a", "task", "open");
  commit(home, "2026-05-18T00:00:00Z", "reopen A");   // W21
  writeNode(home, "task-a", "task", "done");
  commit(home, "2026-05-25T00:00:00Z", "reclose A");   // W22
  writeNode(home, "task-b", "task", "done");
  commit(home, "2026-06-01T00:00:00Z", "born-done B"); // W23

  const ff = analyticsLib.analyze(graphLib.loadGraph(path.join(home, "nodes")), { now: NOW, weeks: 12 }); // fast-forward
  const cache = readClosed(home);
  assert.notEqual(cache.head, oldHead);                 // re-keyed to the new head
  assert.equal(cache.head, execFileSync("git", ["-C", home, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());

  // Force a full rebuild from scratch at the SAME head and compare the whole report.
  fs.rmSync(closedPath(home));
  const full = analyticsLib.analyze(graphLib.loadGraph(path.join(home, "nodes")), { now: NOW, weeks: 12 });
  assert.deepEqual(ff, full);                            // incremental composition == full fold
  assert.equal(ff.totals.completed, 2);                 // A (reclosed W22) + B (born-done W23)
});

test("analyze: a retype-only commit (status untouched) invalidates the cached fold — incremental == cold rebuild", () => {
  // issue-spor-analytics-type-modification-cache-invalidation: `released` is
  // declared terminal only on schema-artifact's OWN status.terminal — a task
  // reaching `released` stays live, so its fold never enters a terminal run.
  // Retyping it to artifact afterward WITHOUT touching status crosses that
  // type-scoped vocabulary: a cold rebuild (which always evaluates every status
  // delta against the node's CURRENT type) correctly dates its completion at the
  // original `released` commit, but foldStatusTransitionState only re-evaluates a
  // node's terminal flag on a ±status: delta — a type-only commit flushes as
  // "unchanged", so a naive incremental read keeps the stale non-terminal state
  // and falls back to a created_at-dated completion instead (still counted
  // "completed" since the outer retired check is independently type-aware, but
  // dated and bucketed wrong — the divergence the acceptance invariant catches).
  const home = initGraph();
  writeNode(home, "task-mistyped", "task", "in-review");
  commit(home, "2026-05-04T00:00:00Z", "create task in review");            // W19
  writeNode(home, "task-mistyped", "task", "released");
  commit(home, "2026-05-11T00:00:00Z", "mark released (not task-terminal)"); // W20
  analyticsLib.analyze(graphLib.loadGraph(path.join(home, "nodes")), { now: NOW, weeks: 12 }); // seed cache: not terminal yet

  // Retype-only commit: `type:` changes, `status:` line untouched.
  writeNode(home, "task-mistyped", "artifact", "released");
  commit(home, "2026-06-01T00:00:00Z", "correct the type: this is really an artifact"); // W23, no ±status: lines

  const incremental = analyticsLib.analyze(graphLib.loadGraph(path.join(home, "nodes")), { now: NOW, weeks: 12 });
  fs.rmSync(closedPath(home));
  const cold = analyticsLib.analyze(graphLib.loadGraph(path.join(home, "nodes")), { now: NOW, weeks: 12 });
  assert.deepEqual(incremental, cold);                    // the acceptance invariant: incremental == cold rebuild
  assert.equal(cold.totals.completed, 1);                 // `released` IS artifact-terminal — completed
  assert.equal(cold.coverage.fromGitTransition, 1);        // dated at the release commit, not a created_at fallback
  const completedWeek = cold.weekly.find((w) => w.completed > 0);
  assert.equal(completedWeek.week, "2026-W20");            // the actual release commit, not the retype week
});

test("analyze: an UNCOMMITTED retype (HEAD unchanged) also invalidates an exact-HEAD cache hit", () => {
  // The exact-HEAD fast path (deriveStatusTransitions's first branch) is keyed
  // only on git HEAD, but graph.nodes reads the WORKING TREE (readGraphFiles),
  // not HEAD's committed content — so a retype edited on disk without a new
  // commit leaves `head` unchanged while graph.nodes[id].type has already moved.
  // Without the retype check gating the exact-HEAD branch too, this would reuse
  // cached.state verbatim and never notice.
  const home = initGraph();
  writeNode(home, "task-mistyped", "task", "in-review");
  commit(home, "2026-05-04T00:00:00Z", "create task in review");            // W19
  writeNode(home, "task-mistyped", "task", "released");
  commit(home, "2026-05-11T00:00:00Z", "mark released (not task-terminal)"); // W20
  analyticsLib.analyze(graphLib.loadGraph(path.join(home, "nodes")), { now: NOW, weeks: 12 }); // seed cache: not terminal

  // Retype on disk WITHOUT committing: HEAD stays exactly where the cache left it.
  writeNode(home, "task-mistyped", "artifact", "released");
  const headBefore = execFileSync("git", ["-C", home, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  const r = analyticsLib.analyze(graphLib.loadGraph(path.join(home, "nodes")), { now: NOW, weeks: 12 });
  assert.equal(execFileSync("git", ["-C", home, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), headBefore); // still uncommitted
  assert.equal(r.totals.completed, 1);              // `released` IS artifact-terminal under the new (uncommitted) type
  assert.equal(r.coverage.fromGitTransition, 1);    // dated at the release commit, not a created_at fallback
});

test("analyze: a non-ancestor cached head (history rewrite) forces a full rebuild", () => {
  const home = closedGraph();
  analyticsLib.analyze(graphLib.loadGraph(path.join(home, "nodes")), { now: NOW, weeks: 12 }); // seed
  // A cached head that is NOT an ancestor of current, with a bogus state.
  fs.writeFileSync(closedPath(home), JSON.stringify({
    head: "0".repeat(40), fp: FP,
    state: { "task-a": { status: "done", terminal: true, runStart: Date.parse("2020-01-01T00:00:00Z") } },
  }));
  const r = analyticsLib.analyze(graphLib.loadGraph(path.join(home, "nodes")), { now: NOW, weeks: 12 });
  assert.equal(r.totals.completed, 1);                   // rebuilt from git, not the bogus non-ancestor cache
  assert.equal(readClosed(home).head, execFileSync("git", ["-C", home, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
});

test("analyze: a non-git home writes no cache and degrades to the fallback (fail-open)", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, "nodes"));
  writeNode(home, "task-a", "task", "done", "", "2026-06-10");
  const g = graphLib.loadGraph(path.join(home, "nodes"));
  const r = analyticsLib.analyze(g, { now: NOW, weeks: 12 });
  assert.equal(r.totals.completed, 1);
  assert.equal(r.coverage.fromFallback, 1);             // created_at/.date fallback, not a git transition
  assert.ok(!fs.existsSync(closedPath(home)));          // no git -> no cache written
});
