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
