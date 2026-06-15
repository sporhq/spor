// Zero-dependency test suite for the decision queue (lib/queue.js).
// Run: node --test
//
// Covers: queueable/live filtering, the four signals (blocking BFS, injected
// activity heat, staleness, age), the default blend + priority bump, the
// staleness "close?" inversion, project filtering, and registry-driven
// queueability (org schema marks a new type queueable).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const graph = require(path.join(__dirname, "..", "lib", "graph.js"));
const { rankQueue } = require(path.join(__dirname, "..", "lib", "queue.js"));

function tmpGraph(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-test-"));
  const nodesDir = path.join(dir, "nodes");
  fs.mkdirSync(nodesDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(nodesDir, name), content);
  }
  return { dir, nodesDir, load: () => graph.loadGraph(nodesDir) };
}

const node = (id, type, { status, project = "my-project", date = "2026-06-01", priority, needed_by, edges = [] } = {}) => [
  `${id}.md`,
  `---
id: ${id}
type: ${type}
project: ${project}
title: Title of ${id}
summary: Standalone summary for ${id} used by queue tests.
${status ? `status: ${status}\n` : ""}${priority ? `priority: ${priority}\n` : ""}${needed_by ? `needed_by: ${needed_by}\n` : ""}date: ${date}
${edges.length ? `edges:\n${edges.map((e) => `  - {type: ${e[0]}, to: ${e[1]}}`).join("\n")}\n` : ""}---
Body of ${id}.
`,
];

// now = 2026-06-11T00:00:00Z so date 2026-06-01 -> age 10d.
const NOW = Date.parse("2026-06-11T00:00:00Z");

test("rankQueue: only queueable types with live status enter the queue", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-live", "task", { status: "active" }),
    node("task-open", "task", { status: "open" }),
    node("task-done", "task", { status: "resolved" }),
    node("task-rejected", "task", { status: "rejected" }),
    node("dec-live", "decision", { status: "active" }), // not queueable
    node("norm-live", "norm", {}),                       // not queueable
  ])).load();
  const r = rankQueue(g, { now: NOW });
  const ids = r.items.map((i) => i.id).sort();
  assert.deepEqual(ids, ["task-live", "task-open"]);
  assert.equal(r.count, 2);
});

test("rankQueue: a merged capture-pending is terminal and leaves the queue", () => {
  // Regression: queue.js kept a local terminal-status list that omitted
  // "merged", so triaged captures surfaced as unprocessed forever
  // (issue-cc-merged-status-omitted-in-consolidation). The vocabulary now
  // lives only in lib/resolution.js.
  const g = tmpGraph(Object.fromEntries([
    node("cap-merged", "capture-pending", { status: "merged" }),
    node("cap-open", "capture-pending", {}),
  ])).load();
  const ids = rankQueue(g, { now: NOW }).items.map((i) => i.id);
  assert.deepEqual(ids, ["cap-open"]);
});

test("rankQueue: a superseded task is not live even with a live status", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-old", "task", { status: "active" }),
    node("task-new", "task", { status: "active", edges: [["supersedes", "task-old"]] }),
  ])).load();
  const ids = rankQueue(g, { now: NOW }).items.map((i) => i.id);
  assert.deepEqual(ids, ["task-new"]);
});

test("rankQueue: blocking counts live nodes transitively reachable over blocks edges", () => {
  const g = tmpGraph(Object.fromEntries([
    // unblocker blocks a, a blocks b; c is blocked but already resolved.
    node("task-unblocker", "task", { status: "open", edges: [["blocks", "task-a"], ["blocks", "issue-c"]] }),
    node("task-a", "task", { status: "open", edges: [["blocks", "task-b"]] }),
    node("task-b", "task", { status: "open" }),
    node("issue-c", "issue", { status: "resolved" }),
  ])).load();
  const r = rankQueue(g, { now: NOW });
  const top = r.items[0];
  assert.equal(top.id, "task-unblocker");
  assert.equal(top.signals.blocking, 2, "task-a + task-b live; resolved issue-c not counted");
  assert.match(top.why, /blocks 2 live nodes/);
  // blend: blocking dominates equal-age peers.
  assert.ok(top.score > r.items[1].score);
});

// ---------------- blocked demotion (issue-cc-queue-ranking-asymmetry) ----------------

test("rankQueue: a blocked item is demoted below its live blocker even when hotter", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-unblocker", "task", { status: "open", edges: [["blocks", "task-gated"]] }),
    node("task-gated", "task", { status: "open" }),
  ])).load();
  // heat would rank the gated item far above its unblocker without the cap.
  const r = rankQueue(g, { now: NOW, activity: { "task-gated": 50 } });
  assert.deepEqual(r.items.map((i) => i.id), ["task-unblocker", "task-gated"]);
  const gated = r.items[1];
  assert.equal(gated.signals.blocked_by, 1);
  assert.equal(gated.suggest, "blocked");
  assert.deepEqual(gated.blocked_by, ["task-unblocker"]);
  assert.match(gated.why, /blocked by task-unblocker — do the unblocker first/);
  assert.ok(gated.score < r.items[0].score);
});

test("rankQueue: blocks-chains cap transitively — unblocker, middle, leaf", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-root", "task", { status: "open", edges: [["blocks", "task-mid"]] }),
    node("task-mid", "task", { status: "open", edges: [["blocks", "task-leaf"]] }),
    node("task-leaf", "task", { status: "open" }),
  ])).load();
  const r = rankQueue(g, { now: NOW, activity: { "task-leaf": 40, "task-mid": 20 } });
  assert.deepEqual(r.items.map((i) => i.id), ["task-root", "task-mid", "task-leaf"]);
});

test("rankQueue: terminal, superseded, or edge-resolved blockers gate nothing", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-free-1", "task", { status: "open" }),
    node("task-done-blocker", "task", { status: "done", edges: [["blocks", "task-free-1"]] }),
    node("task-free-2", "task", { status: "open" }),
    node("task-resolved-blocker", "task", { status: "open", edges: [["blocks", "task-free-2"]] }),
    node("dec-shipper", "decision", { status: "active", edges: [["resolves", "task-resolved-blocker"]] }),
  ])).load();
  const r = rankQueue(g, { now: NOW });
  for (const id of ["task-free-1", "task-free-2"]) {
    const it = r.items.find((i) => i.id === id);
    assert.equal(it.signals.blocked_by, 0, `${id} not gated`);
    assert.equal(it.suggest, "do");
    assert.equal(it.blocked_by, undefined);
  }
});

test("rankQueue: a non-queueable blocker still demotes and flips the suggestion", () => {
  const g = tmpGraph(Object.fromEntries([
    node("dec-gate", "decision", { status: "active", edges: [["blocks", "task-gated"]] }),
    node("task-gated", "task", { status: "open" }),
    node("task-peer", "task", { status: "open" }),
  ])).load();
  const r = rankQueue(g, { now: NOW });
  const gated = r.items.find((i) => i.id === "task-gated");
  assert.equal(gated.suggest, "blocked");
  assert.deepEqual(gated.blocked_by, ["dec-gate"]);
  // blocker isn't in the ranking, so the −3 penalty does the demoting.
  const peer = r.items.find((i) => i.id === "task-peer");
  assert.ok(gated.score < peer.score);
});

test("rankQueue: injected activity heats a node and its 1-hop neighborhood", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hot", "task", { status: "open", edges: [["relates-to", "art-touched"]] }),
    node("task-cold", "task", { status: "open" }),
    node("art-touched", "artifact", {}),
  ])).load();
  const r = rankQueue(g, { now: NOW, activity: { "art-touched": 3, "task-hot": 1 } });
  const hot = r.items.find((i) => i.id === "task-hot");
  const cold = r.items.find((i) => i.id === "task-cold");
  assert.equal(hot.signals.heat, 4);
  assert.equal(cold.signals.heat, 0);
  assert.match(hot.why, /neighborhood active \(heat 4\)/);
  assert.ok(hot.score > cold.score);
});

// ---------------- heat log-compression (issue-cc-queue-blend-heat-dominance) ----------------

test("rankQueue: heat is log-compressed in the blend — raw counts can't drown priority", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-p1-cold", "task", { status: "open", priority: "p1" }),
    node("task-hot", "task", { status: "open" }),
  ])).load();
  // raw heat 50 would bury the p1 bump (6) under the old linear blend;
  // log2(51) ≈ 5.67 keeps the human-set priority on top.
  const r = rankQueue(g, { now: NOW, activity: { "task-hot": 50 } });
  assert.deepEqual(r.items.map((i) => i.id), ["task-p1-cold", "task-hot"]);
  assert.equal(r.items[1].signals.heat, 50, "signals carry the raw count");
});

test("rankQueue: priority why-line attributes the source honestly (issue-cc-priority-attribution-gap)", () => {
  // The why-line used to hardcode "(human-set)" for any priority value, but
  // `priority:` is writable by any token-holder. An unattributed priority must
  // not claim to be human; an attributed one shows who set it via which door.
  const stamped = `---
id: task-stamped
type: task
project: my-project
title: Title of task-stamped
summary: Standalone summary for task-stamped used by queue tests.
status: open
priority: p1
priority_by: Dana Ops <dana@example.com> via mcp
date: 2026-06-01
---
Body.
`;
  const g = tmpGraph({
    "task-stamped.md": stamped,
    ...Object.fromEntries([node("task-bare", "task", { status: "open", priority: "p2" })]),
  }).load();
  const r = rankQueue(g, { now: NOW });
  const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.match(byId["task-stamped"].why, /priority p1 \(set by Dana Ops <dana@example\.com> via mcp\)/);
  assert.match(byId["task-bare"].why, /priority p2 \(source unrecorded\)/);
  assert.doesNotMatch(byId["task-bare"].why, /human-set/);
});

test("rankQueue: heat still orders items — hotter beats colder, no ties introduced", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-warm", "task", { status: "open" }),
    node("task-hotter", "task", { status: "open" }),
  ])).load();
  const r = rankQueue(g, { now: NOW, activity: { "task-hotter": 600, "task-warm": 500 } });
  assert.deepEqual(r.items.map((i) => i.id), ["task-hotter", "task-warm"]);
  assert.ok(r.items[0].score > r.items[1].score);
});

test("rankQueue: blocking outranks a hot but structurally idle peer", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-unblocker", "task", { status: "open", edges: [["blocks", "task-a"], ["blocks", "task-b"]] }),
    node("task-a", "task", { status: "open" }),
    node("task-b", "task", { status: "open" }),
    node("task-hot-idle", "task", { status: "open" }),
  ])).load();
  // heat 60 → log2(61) ≈ 5.93 < 3·blocking (6): structure wins.
  const r = rankQueue(g, { now: NOW, activity: { "task-hot-idle": 60 } });
  assert.equal(r.items[0].id, "task-unblocker");
});

test("rankQueue: stale anchors flip the suggestion to close instead of boosting", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-stale", "task", { status: "open", edges: [["derived-from", "spec-old"], ["relates-to", "ghost-gone"]] }),
    node("spec-old", "artifact", {}),
    node("spec-new", "artifact", { edges: [["supersedes", "spec-old"]] }),
  ])).load();
  const it = rankQueue(g, { now: NOW }).items.find((i) => i.id === "task-stale");
  assert.equal(it.signals.staleness, 1, "both anchors superseded or missing");
  assert.equal(it.suggest, "close");
  assert.match(it.why, /100% of anchors superseded or gone — consider closing/);
});

test("rankQueue: human priority bumps the blend and shows in the why", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-p1", "task", { status: "open", priority: "p1" }),
    node("task-plain", "task", { status: "open", edges: [["blocks", "task-blocked"]] }),
    node("task-blocked", "task", { status: "open" }),
  ])).load();
  const r = rankQueue(g, { now: NOW });
  assert.equal(r.items[0].id, "task-p1", "p1 bump (6) beats one blocking edge (3)");
  assert.match(r.items[0].why, /priority p1 \(source unrecorded\)/);
  assert.equal(r.items[0].priority, "p1");
});

test("rankQueue: age contributes (capped) and is reported", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-older", "task", { status: "open", date: "2026-05-12" }), // 30d
    node("task-newer", "task", { status: "open", date: "2026-06-09" }), // 2d
  ])).load();
  const r = rankQueue(g, { now: NOW });
  assert.equal(r.items[0].id, "task-older");
  assert.equal(r.items[0].signals.age_days, 30);
  assert.match(r.items[0].why, /30d old/);
});

test("rankQueue: project filter and limit", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-my-project-1", "task", { status: "open", project: "my-project" }),
    node("task-my-project-2", "task", { status: "open", project: "my-project" }),
    node("task-wf-1", "task", { status: "open", project: "wf" }),
  ])).load();
  const r = rankQueue(g, { now: NOW, project: "my-project", limit: 1 });
  assert.equal(r.count, 2);
  assert.equal(r.items.length, 1);
  assert.ok(r.items[0].id.startsWith("task-my-project-"));
});

// ---------------- assignee filter (assigned / stewards edges) ----------------
// task-cc-queue-assignee-filtering: the per-person scope the seed assigned/
// stewards schemas always promised. `assignee` is a person node id; the queue
// narrows to the union of work assigned to them (work→person `assigned`) and
// the nodes they steward (person→node `stewards`).

test("rankQueue: assignee scopes the queue to assigned + stewarded work", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-assigned-x", "task", { status: "open", edges: [["assigned", "person-x"]] }),
    node("task-stewarded-x", "task", { status: "open" }),
    node("task-assigned-y", "task", { status: "open", edges: [["assigned", "person-y"]] }),
    node("task-unowned", "task", { status: "open" }),
    node("person-x", "person", { edges: [["stewards", "task-stewarded-x"]] }),
    node("person-y", "person", {}),
  ])).load();
  const r = rankQueue(g, { now: NOW, assignee: "person-x" });
  assert.deepEqual(r.items.map((i) => i.id).sort(), ["task-assigned-x", "task-stewarded-x"]);
  assert.equal(r.count, 2, "count describes this person's queue, not the firehose");
});

test("rankQueue: an unknown or departed assignee yields an empty queue, not the whole team's", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-1", "task", { status: "open", edges: [["assigned", "person-x"]] }),
    node("task-2", "task", { status: "open" }),
  ])).load();
  const r = rankQueue(g, { now: NOW, assignee: "person-nobody" });
  assert.deepEqual(r.items, []);
  assert.equal(r.count, 0);
});

test("rankQueue: no assignee scopes nothing — assigned edges don't change the unfiltered queue", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-assigned-x", "task", { status: "open", edges: [["assigned", "person-x"]] }),
    node("task-unowned", "task", { status: "open" }),
    node("person-x", "person", { edges: [["stewards", "task-unowned"]] }),
  ])).load();
  const r = rankQueue(g, { now: NOW });
  assert.deepEqual(r.items.map((i) => i.id).sort(), ["task-assigned-x", "task-unowned"]);
  assert.equal(r.count, 2);
});

test("rankQueue: assignee composes with the project filter", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-alpha", "task", { status: "open", project: "alpha", edges: [["assigned", "person-x"]] }),
    node("task-beta", "task", { status: "open", project: "beta", edges: [["assigned", "person-x"]] }),
    node("person-x", "person", {}),
  ])).load();
  const r = rankQueue(g, { now: NOW, assignee: "person-x", project: "alpha" });
  assert.deepEqual(r.items.map((i) => i.id), ["task-alpha"]);
  assert.equal(r.count, 1);
});

test("rankQueue: capture-pending nodes queue for triage (seed queueable)", () => {
  const g = tmpGraph(Object.fromEntries([
    node("cap-2026-06-10-1", "capture-pending", {}),
  ])).load();
  const r = rankQueue(g, { now: NOW });
  assert.equal(r.items.length, 1);
  assert.match(r.items[0].why, /unprocessed capture awaiting triage/);
});

test("rankQueue: an org schema node makes a new type queueable", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-x", "task", { status: "open" }),
    ["schema-review.md", `---
id: schema-review
type: schema
kind: node-schema
schema_version: 2026.06.10.1
title: Review queue items
summary: Org-specific review type that participates in the decision queue.
date: 2026-06-10
---

\`\`\`json
{ "node_type": "review", "prefix": ["rev-"], "queueable": true }
\`\`\`
`],
    node("rev-merge-1", "review", { status: "open" }),
  ])).load();
  const ids = rankQueue(g, { now: NOW }).items.map((i) => i.id).sort();
  assert.deepEqual(ids, ["rev-merge-1", "task-x"]);
});

// ---------------- resolution truth (issue-cc-status-lags-resolution-edges) ----------------

test("rankQueue: a live inbound resolves edge retires an item whatever its status says", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-shipped", "task", { status: "open" }), // status lags
    node("task-actually-open", "task", { status: "open" }),
    node("dec-shipper", "decision", { status: "active", edges: [["resolves", "task-shipped"]] }),
  ])).load();
  const r = rankQueue(g, { now: NOW });
  assert.deepEqual(r.items.map((i) => i.id), ["task-actually-open"]);
  assert.equal(r.count, 1, "retired item leaves the count too");
});

test("rankQueue: a rejected or superseded resolver does not retire its target", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-x", "task", { status: "open" }),
    node("dec-withdrawn", "decision", { status: "rejected", edges: [["resolves", "task-x"]] }),
    node("task-y", "task", { status: "open" }),
    node("dec-old", "decision", { edges: [["resolves", "task-y"]] }),
    node("dec-new", "decision", { edges: [["supersedes", "dec-old"]] }),
  ])).load();
  const ids = rankQueue(g, { now: NOW }).items.map((i) => i.id).sort();
  assert.deepEqual(ids, ["task-x", "task-y"], "withdrawn fixes resolve nothing");
});

test("rankQueue: an in-review/approved artifact keeps its task live; merged retires it", () => {
  // dec-spor-definition-of-done-org-policy: a resolver in a non-resolving
  // delivery stage does not retire its target — the overnight-review smell,
  // gone without a hand-managed `open` status. The partition is read off the
  // registry (the artifact schema's status.non_resolving), not a kernel table.
  const g = tmpGraph(Object.fromEntries([
    node("task-in-review", "task", { status: "open" }),
    node("art-pr-1", "artifact", { status: "in-review", edges: [["resolves", "task-in-review"]] }),
    node("task-approved", "task", { status: "open" }),
    node("art-pr-2", "artifact", { status: "approved", edges: [["resolves", "task-approved"]] }),
    node("task-merged", "task", { status: "open" }),
    node("art-pr-3", "artifact", { status: "merged", edges: [["resolves", "task-merged"]] }),
  ])).load();
  const ids = rankQueue(g, { now: NOW }).items.map((i) => i.id).sort();
  assert.deepEqual(ids, ["task-approved", "task-in-review"],
    "in-review/approved changes keep their tasks queued; the merged one is retired");
});

test("rankQueue: an answers edge retires questions only, never a task", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-z", "task", { status: "open" }),
    node("dec-answerer", "decision", { status: "active", edges: [["answers", "task-z"]] }),
  ])).load();
  assert.deepEqual(rankQueue(g, { now: NOW }).items.map((i) => i.id), ["task-z"]);
});

test("rankQueue: open gardener findings about an item ride along in findings and the why", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-flagged", "task", { status: "open" }),
    node("find-cold-work-task-flagged", "finding", { status: "open", edges: [["relates-to", "task-flagged"]] }),
    node("find-resolved-already", "finding", { status: "resolved", edges: [["relates-to", "task-flagged"]] }),
  ])).load();
  const it = rankQueue(g, { now: NOW }).items.find((i) => i.id === "task-flagged");
  assert.deepEqual(it.findings, ["find-cold-work-task-flagged"], "only OPEN findings ride along");
  assert.match(it.why, /1 open gardener finding: find-cold-work-task-flagged/);
});

// ---------------- front signal (dec-cc-queue-front-from-attribution) ----------------

test("rankQueue: injected front activity surfaces the viewer's working front", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-my-front", "task", { status: "open" }),
    node("task-other", "task", { status: "open" }),
  ])).load();
  const r = rankQueue(g, { now: NOW, front: { "task-my-front": 7 } });
  assert.equal(r.items[0].id, "task-my-front");
  assert.equal(r.items[0].signals.front, 7);
  assert.match(r.items[0].why, /your active front \(7 writes in the last 7 days\)/);
});

test("rankQueue: front why-line states the actual window, not a fixed 'this week'", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-windowed", "task", { status: "open" }),
  ])).load();
  const r = rankQueue(g, { now: NOW, front: { "task-windowed": 1 }, frontDays: 30 });
  // singular write + non-default window: pluralization adapts and the literal
  // window is stated (task-cc-local-front-productionize).
  assert.match(r.items[0].why, /your active front \(1 write in the last 30 days\)/);
});

test("rankQueue: front caps below the p1 bump — human priority stays supreme", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-p1", "task", { status: "open", priority: "p1" }),
    node("task-worked", "task", { status: "open" }),
  ])).load();
  // even an absurd write count contributes at most 5 < 6 (p1); both items
  // share the same age term, so p1 must stay strictly ahead.
  const r = rankQueue(g, { now: NOW, front: { "task-worked": 10000 } });
  assert.equal(r.items[0].id, "task-p1");
  const worked = r.items.find((i) => i.id === "task-worked");
  assert.ok(r.items[0].score - worked.score >= 0.99, "cap (5) stays below the p1 bump (6)");
});

test("rankQueue: front counts the node itself only — no neighborhood spread", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-hub", "task", { status: "open" }),
    node("task-spoke", "task", { status: "open", edges: [["derived-from", "task-hub"]] }),
  ])).load();
  const r = rankQueue(g, { now: NOW, front: { "task-spoke": 4 } });
  const hub = r.items.find((i) => i.id === "task-hub");
  assert.equal(hub.signals.front, 0, "provenance hub gets nothing from its spokes");
});

// ---------------- personal mutes (person queue_mute register) ----------------

const PERSON = (id, mutes) => [
  `${id}.md`,
  `---
id: ${id}
type: person
project: my-project
title: Person ${id}
summary: Person node for queue_mute tests.
email: ${id}@example.com
queue_mute: [${mutes.join(", ")}]
date: 2026-06-01
---
Body.
`,
];

test("rankQueue: a viewer's queue_mute hides a whole project, counted not silent", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-my-project-1", "task", { status: "open", project: "my-project" }),
    node("task-my-project-2", "task", { status: "open", project: "my-project" }),
    node("task-wf-1", "task", { status: "open", project: "wf" }),
    PERSON("person-t", ["my-project"]),
  ])).load();
  const r = rankQueue(g, { now: NOW, viewer: g.nodes["person-t"] });
  assert.deepEqual(r.items.map((i) => i.id), ["task-wf-1"]);
  assert.equal(r.count, 1, "muted items leave the count");
  assert.equal(r.muted, 2);
});

test("rankQueue: queue_mute can name a single node id", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-noisy", "task", { status: "open" }),
    node("task-other", "task", { status: "open" }),
    PERSON("person-t", ["task-noisy"]),
  ])).load();
  const r = rankQueue(g, { now: NOW, viewer: g.nodes["person-t"] });
  assert.deepEqual(r.items.map((i) => i.id), ["task-other"]);
  assert.equal(r.muted, 1);
});

test("rankQueue: @date expiry — future mute hides, past or malformed mute is inactive", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-future", "task", { status: "open", project: "p-future" }),
    node("task-past", "task", { status: "open", project: "p-past" }),
    node("task-junk", "task", { status: "open", project: "p-junk" }),
    PERSON("person-t", ["p-future@2026-07-01", "p-past@2026-06-01", "p-junk@whenever"]),
  ])).load();
  const r = rankQueue(g, { now: NOW, viewer: g.nodes["person-t"] });
  assert.deepEqual(r.items.map((i) => i.id).sort(), ["task-junk", "task-past"]);
  assert.equal(r.muted, 1, "only the unexpired mute hides");
});

test("rankQueue: no viewer (or no register) mutes nothing — others see everything", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-my-project-1", "task", { status: "open", project: "my-project" }),
    PERSON("person-muter", ["my-project"]),
    PERSON("person-other", []),
  ])).load();
  assert.equal(rankQueue(g, { now: NOW }).items.length, 1, "anonymous sees all");
  assert.equal(rankQueue(g, { now: NOW, viewer: g.nodes["person-other"] }).items.length, 1);
  const r = rankQueue(g, { now: NOW });
  assert.equal(r.muted, undefined, "no muted field when nothing hidden");
});

// ---------------- task claim-lease intersection ----------------
// dec-cc-task-claim-lease + dec-cc-task-resumption-reservation: rankQueue
// intersects durable `assigned` edges with an INJECTED, ephemeral lease table
// (`leases: { nodeId -> { by, expires, reserved? } }`, exactly server/leases.js
// snapshot()'s shape) at read time. An in-force lease held by ANOTHER viewer is
// owner-exclusive: hidden from their actionable list and counted (leased /
// reserved), surfaced in the holder's own queue and in the steward/capacity
// view (assignee set). Lapsed past `now` -> full pool for everyone. Absent/empty
// leases -> byte-identical to before (the local-mode-without-server case).

// viewer person nodes for the lease comparand (lease `by` == viewer.id).
const LEASE_PERSON = (id) => [
  `${id}.md`,
  `---
id: ${id}
type: person
project: my-project
title: Person ${id}
summary: Person node for claim-lease tests.
email: ${id}@example.com
date: 2026-06-01
---
Body.
`,
];

const LIVE = NOW + 30 * 60 * 1000;   // 30m ahead -> in force at NOW
const LAPSED = NOW - 60 * 1000;      // 1m past -> not in force at NOW

test("lease: absent or empty leases is byte-identical to no lease table", () => {
  const files = Object.fromEntries([
    node("task-a", "task", { status: "open" }),
    node("task-b", "task", { status: "open", edges: [["assigned", "person-x"]] }),
    LEASE_PERSON("person-x"),
  ]);
  const base = rankQueue(tmpGraph(files).load(), { now: NOW });
  const withNull = rankQueue(tmpGraph(files).load(), { now: NOW, leases: null });
  const withEmpty = rankQueue(tmpGraph(files).load(), { now: NOW, leases: {} });
  assert.deepEqual(withNull, base, "leases:null changes nothing");
  assert.deepEqual(withEmpty, base, "leases:{} changes nothing");
  assert.equal(base.leased, undefined);
  assert.equal(base.reserved, undefined);
  // no lease_state rides along on any item
  for (const it of base.items) assert.equal(it.lease_state, undefined);
});

test("lease: a live lease held by ANOTHER is owner-exclusive — hidden + counted as leased", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-held", "task", { status: "open", edges: [["assigned", "person-x"]] }),
    node("task-free", "task", { status: "open" }),
    LEASE_PERSON("person-x"),
    LEASE_PERSON("person-v"),
  ])).load();
  const r = rankQueue(g, {
    now: NOW,
    viewer: g.nodes["person-v"],
    leases: { "task-held": { by: "person-x", expires: LIVE } },
  });
  assert.deepEqual(r.items.map((i) => i.id), ["task-free"], "the live-claimed task is hidden from teammate V");
  assert.equal(r.count, 1, "the hidden item leaves the count");
  assert.equal(r.leased, 1, "counted, not silent");
  assert.equal(r.reserved, undefined);
});

test("lease: a live lease held by the VIEWER stays in their own queue, tagged in_progress", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-mine", "task", { status: "open", edges: [["assigned", "person-v"]] }),
    LEASE_PERSON("person-v"),
  ])).load();
  const r = rankQueue(g, {
    now: NOW,
    viewer: g.nodes["person-v"],
    leases: { "task-mine": { by: "person-v", expires: LIVE } },
  });
  assert.deepEqual(r.items.map((i) => i.id), ["task-mine"], "owner keeps their own claimed work");
  assert.equal(r.leased, undefined, "the owner's own lease is not a demotion");
  const it = r.items[0];
  assert.equal(it.lease_state, "in_progress");
  assert.equal(it.lease_by, "person-v");
  assert.match(it.why, /in progress \(your claim\)/);
});

test("lease: a lapsed-in-grace reservation held by ANOTHER is owner-exclusive — counted as reserved", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-resv", "task", { status: "open", edges: [["assigned", "person-x"]] }),
    LEASE_PERSON("person-x"),
    LEASE_PERSON("person-v"),
  ])).load();
  // Tier-2: a clean SessionEnd converted the active lease into a reservation
  // whose `expires` is the grace-window edge (still in force at NOW), reserved:true.
  const r = rankQueue(g, {
    now: NOW,
    viewer: g.nodes["person-v"],
    leases: { "task-resv": { by: "person-x", expires: LIVE, reserved: true } },
  });
  assert.deepEqual(r.items.map((i) => i.id), [], "reservation hides the half-done work from teammate V");
  assert.equal(r.reserved, 1, "Tier-2 demotion counted under reserved, not leased");
  assert.equal(r.leased, undefined);
});

test("lease: the reservation owner sees it at the top of their own queue, tagged reserved", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-resv", "task", { status: "open", date: "2026-06-10", edges: [["assigned", "person-v"]] }),
    LEASE_PERSON("person-v"),
  ])).load();
  const r = rankQueue(g, {
    now: NOW,
    viewer: g.nodes["person-v"],
    front: { "task-resv": 5 }, // their front floats it up for free (the design)
    leases: { "task-resv": { by: "person-v", expires: LIVE, reserved: true } },
  });
  assert.deepEqual(r.items.map((i) => i.id), ["task-resv"]);
  assert.equal(r.reserved, undefined, "the owner's own reservation is not a demotion");
  const it = r.items[0];
  assert.equal(it.lease_state, "reserved");
  assert.match(it.why, /reserved \(your claim\)/);
});

test("lease: a lease expired past now is NOT in force — full pool for everyone (grace exceeded)", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-lapsed", "task", { status: "open", edges: [["assigned", "person-x"]] }),
    LEASE_PERSON("person-x"),
    LEASE_PERSON("person-v"),
  ])).load();
  const lease = { "task-lapsed": { by: "person-x", expires: LAPSED, reserved: true } };
  const teammate = rankQueue(g, { now: NOW, viewer: g.nodes["person-v"], leases: lease });
  assert.deepEqual(teammate.items.map((i) => i.id), ["task-lapsed"], "escalates back to the teammate's pool");
  assert.equal(teammate.leased, undefined);
  assert.equal(teammate.reserved, undefined, "an expired entry demotes nobody");
  assert.equal(teammate.items[0].lease_state, undefined, "no stale lease tag on an escalated item");
});

test("lease: viewer-relative — one live lease, hidden from the teammate but kept for the holder", () => {
  const files = Object.fromEntries([
    node("task-x", "task", { status: "open", edges: [["assigned", "person-x"]] }),
    LEASE_PERSON("person-x"),
    LEASE_PERSON("person-v"),
  ]);
  const lease = { "task-x": { by: "person-x", expires: LIVE } };
  const holder = rankQueue(tmpGraph(files).load(), { now: NOW, viewer: tmpGraph(files).load().nodes["person-x"], leases: lease });
  const teammate = rankQueue(tmpGraph(files).load(), { now: NOW, viewer: tmpGraph(files).load().nodes["person-v"], leases: lease });
  assert.deepEqual(holder.items.map((i) => i.id), ["task-x"], "holder sees their own claim");
  assert.equal(holder.items[0].lease_state, "in_progress");
  assert.deepEqual(teammate.items.map((i) => i.id), [], "teammate does not");
  assert.equal(teammate.leased, 1);
});

test("lease: an anonymous read (no viewer) treats every in-force lease as held by another", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-x", "task", { status: "open", edges: [["assigned", "person-x"]] }),
    LEASE_PERSON("person-x"),
  ])).load();
  const r = rankQueue(g, { now: NOW, leases: { "task-x": { by: "person-x", expires: LIVE } } });
  assert.deepEqual(r.items.map((i) => i.id), [], "the firehose hides others' live claims");
  assert.equal(r.leased, 1);
});

test("lease: the steward/capacity view (assignee set) is lease-exempt — shows the claim, by holder", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-x", "task", { status: "open", edges: [["assigned", "person-x"]] }),
    LEASE_PERSON("person-x"),
    LEASE_PERSON("person-mgr"),
  ])).load();
  // A manager scoping to person-x's carried work; person-x holds a live lease.
  const r = rankQueue(g, {
    now: NOW,
    assignee: "person-x",
    viewer: g.nodes["person-mgr"],
    leases: { "task-x": { by: "person-x", expires: LIVE } },
  });
  assert.deepEqual(r.items.map((i) => i.id), ["task-x"], "the capacity view surfaces the claimed work");
  assert.equal(r.leased, undefined, "no hiding in the steward view");
  const it = r.items[0];
  assert.equal(it.lease_state, "in_progress");
  assert.equal(it.lease_by, "person-x");
  assert.match(it.why, /in progress by person-x/, "the steward sees who holds it");
});

test("lease: leased and reserved counts coexist and stack per state", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-live-1", "task", { status: "open", edges: [["assigned", "person-x"]] }),
    node("task-live-2", "task", { status: "open", edges: [["assigned", "person-x"]] }),
    node("task-resv-1", "task", { status: "open", edges: [["assigned", "person-x"]] }),
    node("task-open", "task", { status: "open" }),
    LEASE_PERSON("person-x"),
    LEASE_PERSON("person-v"),
  ])).load();
  const r = rankQueue(g, {
    now: NOW,
    viewer: g.nodes["person-v"],
    leases: {
      "task-live-1": { by: "person-x", expires: LIVE },
      "task-live-2": { by: "person-x", expires: LIVE },
      "task-resv-1": { by: "person-x", expires: LIVE, reserved: true },
    },
  });
  assert.deepEqual(r.items.map((i) => i.id), ["task-open"], "only the unclaimed task is actionable for V");
  assert.equal(r.leased, 2);
  assert.equal(r.reserved, 1);
  assert.equal(r.count, 1);
});

// ---------------- queue-policy override (QUEUE.md §4/§8) ----------------

const POLICY = (body, { id = "schema-queue-policy", status = "active", version = "2026.06.11.1" } = {}) => [
  `${id}.md`,
  `---
id: ${id}
type: schema
kind: queue-policy
schema_version: ${version}
title: Org queue policy
summary: Org-defined ranking blend for the decision queue, replacing the built-in default.
status: ${status}
date: 2026-06-11
---

\`\`\`json
{ "description": "test policy" }
\`\`\`

\`\`\`js
${body}
\`\`\`
`,
];

test("queue-policy: attached rank() replaces the default blend", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-newer", "task", { status: "open", date: "2026-06-09" }),
    node("task-older", "task", { status: "open", date: "2026-05-12" }),
    // newest-first: invert the age signal the default blend rewards.
    POLICY(`export function rank(items) {
  return items.map(function (it) { return { id: it.id, score: 100 - (it.signals.age_days || 0) }; });
}`),
  ])).load();
  const r = rankQueue(g, { now: NOW });
  assert.deepEqual(r.policy, { id: "schema-queue-policy", applied: true });
  assert.deepEqual(r.items.map((i) => i.id), ["task-newer", "task-older"]);
  assert.equal(r.items[0].score, 98);
});

test("queue-policy: {id: score} map form works; unmentioned items keep the default", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-a", "task", { status: "open" }),
    node("task-b", "task", { status: "open", priority: "p1" }),
    POLICY(`export function rank(items) { return { "task-a": 50 }; }`),
  ])).load();
  const r = rankQueue(g, { now: NOW });
  assert.equal(r.items[0].id, "task-a");
  assert.equal(r.items[0].score, 50);
  const b = r.items.find((i) => i.id === "task-b");
  assert.ok(b.score < 50, "task-b keeps its default-blend score");
});

test("queue-policy: a broken policy is fail-soft — default blend stands, error reported", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-p1", "task", { status: "open", priority: "p1" }),
    node("task-plain", "task", { status: "open" }),
    POLICY(`export function rank(items) { throw new Error("boom"); }`),
  ])).load();
  const r = rankQueue(g, { now: NOW });
  assert.equal(r.policy.applied, false);
  assert.match(r.policy.error, /boom/);
  assert.equal(r.items[0].id, "task-p1", "default blend still ranks");
});

test("queue-policy: a proposed policy node is inert until activated", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-x", "task", { status: "open" }),
    POLICY(`export function rank(items) { return { "task-x": 999 }; }`, { status: "proposed" }),
  ])).load();
  const r = rankQueue(g, { now: NOW });
  assert.equal(r.policy, undefined, "no active policy: result carries no policy field");
  assert.notEqual(r.items.find((i) => i.id === "task-x").score, 999);
});

test("registry: seed queueability — work types yes, record types no", () => {
  const reg = graph.seedRegistry();
  for (const t of ["task", "capture-pending", "issue", "incident"]) {
    assert.equal(reg.isQueueable(t), true, `${t} queueable`);
  }
  for (const t of ["decision", "artifact", "norm", "briefing", "correction", "schema"]) {
    assert.equal(reg.isQueueable(t), false, `${t} not queueable`);
  }
});

// ---------- scheduled dormancy: wake dates (QUEUE.md §4) ----------

// Raw node with a wake: field (the node() helper has no slot for it).
const wakeNode = (id, wake, { status = "open", priority } = {}) => [
  `${id}.md`,
  `---
id: ${id}
type: task
project: my-project
title: Title of ${id}
summary: Standalone summary for ${id} used by wake tests.
status: ${status}
${priority ? `priority: ${priority}\n` : ""}wake: ${wake}
date: 2026-06-01
---
Body of ${id}.
`,
];

test("wake: a future date parks the item — counted dormant, not ranked, for every viewer", () => {
  const g = tmpGraph(Object.fromEntries([
    wakeNode("task-renew-cert", "2027-05-01", { priority: "p1" }),
    node("task-now", "task", { status: "open" }),
  ])).load();
  const r = rankQueue(g, { now: NOW });
  assert.deepEqual(r.items.map((i) => i.id), ["task-now"]);
  assert.equal(r.dormant, 1);
  assert.equal(r.count, 1, "dormant items are not in count");
});

test("wake: on and after the date the item surfaces with priority intact and a woke marker", () => {
  const g = tmpGraph(Object.fromEntries([
    wakeNode("task-renew-cert", "2026-06-11", { priority: "p1" }),
    node("task-plain", "task", { status: "open" }),
  ])).load();
  const r = rankQueue(g, { now: NOW }); // NOW is exactly 2026-06-11T00:00Z — wake day
  assert.equal(r.items[0].id, "task-renew-cert", "p1 ranks first once awake");
  assert.match(r.items[0].why, /priority p1/);
  assert.match(r.items[0].why, /woke 2026-06-11 \(was dormant\)/);
  assert.equal(r.dormant, undefined);
});

test("wake: an unparseable date fails open to awake (the validator warns instead)", () => {
  const g = tmpGraph(Object.fromEntries([
    wakeNode("task-bad-wake", "next-spring"),
  ])).load();
  const r = rankQueue(g, { now: NOW });
  assert.deepEqual(r.items.map((i) => i.id), ["task-bad-wake"]);
  assert.equal(r.dormant, undefined);
  const v = graph.validateGraph(g.nodesDir);
  assert.ok(v.warnings.some((w) => w.includes("wake 'next-spring' is not a parseable date")), v.warnings.join("; "));
});

test("wake: dormant wins over muted in the counts — graph state before personal preference", () => {
  const g = tmpGraph(Object.fromEntries([
    wakeNode("task-later", "2027-01-01"),
  ])).load();
  const r = rankQueue(g, { now: NOW, viewer: { queue_mute: ["task-later"] } });
  assert.equal(r.dormant, 1);
  assert.equal(r.muted, undefined);
});

// --- needed_by: deadline urgency (task-cc-xproject-dependency-loop) ----------
// NOW is 2026-06-11. The term ramps 0 -> 3 over the 30-day window to the date,
// then 3 -> 5 once overdue. Absent/unparseable contributes exactly 0, so a node
// without needed_by scores byte-identically to before the term existed.
test("needed_by: a node without a deadline carries no needed_by signal", () => {
  const g = tmpGraph(Object.fromEntries([node("task-plain", "task")])).load();
  const it = rankQueue(g, { now: NOW }).items[0];
  assert.equal("needed_by_days" in it.signals, false);
});

test("needed_by: far-future deadline is visible but contributes no score yet", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-base", "task"),
    node("task-far", "task", { needed_by: "2026-08-01" }), // 51d out, beyond the 30d window
  ])).load();
  const items = rankQueue(g, { now: NOW }).items;
  const base = items.find((i) => i.id === "task-base");
  const far = items.find((i) => i.id === "task-far");
  assert.equal(far.score, base.score);          // urgency 0 beyond the window
  assert.equal(far.signals.needed_by_days, 51); // but the deadline still shows
  assert.match(far.why, /needed by 2026-08-01 \(51d\)/);
});

test("needed_by: due today adds exactly NEAR (3) and ramps linearly mid-window", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-base", "task"),
    node("task-today", "task", { needed_by: "2026-06-11" }), // d=0
    node("task-mid", "task", { needed_by: "2026-06-26" }),   // d=15 -> 3*(15/30)=1.5
  ])).load();
  const items = rankQueue(g, { now: NOW }).items;
  const base = items.find((i) => i.id === "task-base").score;
  const today = items.find((i) => i.id === "task-today");
  const mid = items.find((i) => i.id === "task-mid").score;
  assert.equal(Number((today.score - base).toFixed(2)), 3);
  assert.equal(Number((mid - base).toFixed(2)), 1.5);
  assert.equal(today.signals.needed_by_days, 0);
  assert.match(today.why, /needed by 2026-06-11 \(0d\)/);
});

test("needed_by: overdue caps at NEAR+OVERDUE (5) and renders OVERDUE", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-base", "task"),
    node("task-late", "task", { needed_by: "2026-05-01" }), // 41d overdue -> capped
  ])).load();
  const items = rankQueue(g, { now: NOW }).items;
  const base = items.find((i) => i.id === "task-base").score;
  const late = items.find((i) => i.id === "task-late");
  assert.equal(Number((late.score - base).toFixed(2)), 5);
  assert.equal(late.signals.needed_by_days, -41);
  assert.match(late.why, /OVERDUE — needed by 2026-05-01 \(41d ago\)/);
});

test("needed_by: an overdue deadline outranks an identical fresh task", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-quiet", "task"),
    node("task-urgent", "task", { needed_by: "2026-05-20" }),
  ])).load();
  const ids = rankQueue(g, { now: NOW }).items.map((i) => i.id);
  assert.deepEqual(ids, ["task-urgent", "task-quiet"]);
});

test("needed_by: an unparseable date fails open to no urgency and warns", () => {
  const t = tmpGraph(Object.fromEntries([
    node("task-bad-due", "task", { needed_by: "soon" }),
  ]));
  const g = t.load();
  const it = rankQueue(g, { now: NOW }).items[0];
  assert.equal("needed_by_days" in it.signals, false); // no boost, no crash
  assert.doesNotMatch(it.why, /needed by/);
  const v = graph.validateGraph(t.nodesDir);
  assert.ok(v.warnings.some((w) => w.includes("needed_by 'soon' is not a parseable date")), v.warnings.join("; "));
});

// --- cross-project provenance in the why-line (task-cc-xproject-dependency-loop) ---
// A blocks relationship that crosses a project boundary names the other side
// and its project; same-project relationships render exactly as before.
test("provenance: a serving blocker names the cross-project requester it serves", () => {
  const g = tmpGraph(Object.fromEntries([
    // task-dep lives in the SERVING project and blocks a requester in another.
    node("task-dep", "task", { project: "spor", status: "open", edges: [["blocks", "task-req"]] }),
    node("task-req", "task", { project: "wf", status: "open" }),
  ])).load();
  const items = rankQueue(g, { now: NOW }).items;
  const dep = items.find((i) => i.id === "task-dep");
  const req = items.find((i) => i.id === "task-req");
  assert.match(dep.why, /blocks 1 live node across projects: task-req \(wf\)/);
  assert.match(req.why, /blocked by task-dep \(spor\) — do the unblocker first/);
});

test("provenance: a same-project blocker renders the bare count and id (unchanged)", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-up", "task", { project: "p1", status: "open", edges: [["blocks", "task-down"]] }),
    node("task-down", "task", { project: "p1", status: "open" }),
  ])).load();
  const items = rankQueue(g, { now: NOW }).items;
  assert.match(items.find((i) => i.id === "task-up").why, /blocks 1 live node\b/);
  assert.match(items.find((i) => i.id === "task-down").why, /blocked by task-up — do the unblocker first/);
  assert.doesNotMatch(items.find((i) => i.id === "task-up").why, /across projects/);
});

test("provenance: mixed blockers annotate only the cross-project one", () => {
  const g = tmpGraph(Object.fromEntries([
    node("task-mixed", "task", { project: "home", status: "open" }),
    node("task-same", "task", { project: "home", status: "open", edges: [["blocks", "task-mixed"]] }),
    node("task-ext", "task", { project: "other", status: "open", edges: [["blocks", "task-mixed"]] }),
  ])).load();
  // blockers list in node-id sort order: task-ext then task-same.
  const why = rankQueue(g, { now: NOW }).items.find((i) => i.id === "task-mixed").why;
  assert.match(why, /blocked by task-ext \(other\), task-same — do the unblocker first/);
});
