"use strict";
// shell/work-program.js — `spor work --program <id>`, the program SCOPE over the
// work loop (task-spor-program-scoped-factory-execution).
//
// A program run is a SELECTION scope, never a second dispatcher: the loop's
// candidate set is narrowed to the program's members, the order is the
// queue's own (a member another member `blocks` is not on the dispatchable
// page until its blocker lands), and every launch still goes through
// `spor dispatch` with all of its guards. What this module owns is the one
// read the scope needs once per pass: WHO is in the program and WHERE each
// member stands, so the loop can say when the program is over — every member
// terminal — or stuck: every remaining member needs a person or cannot run.
//
// MEMBERSHIP is the transitive `member-of-program` closure of the root (the
// triage decision on the task): a member's own blockers that the program
// view's blocks-fallback would pull in are NOT members, because a scope that
// silently widened to every prerequisite would dispatch work nobody put in
// the program. The closure is read off the SAME program envelope `spor
// program` renders in both modes (kernel/program.js walkProgram locally,
// GET /v1/program/{id}?format=envelope remotely), so a member's bucket here
// is exactly the bucket the program view shows — the queue's truth (terminal
// status, supersession, a live resolves/answers edge).
//
// Plain Node, zero deps.

const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const programKernel = require(path.join(ROOT, "lib", "kernel", "program.js"));
const queue = require(path.join(ROOT, "lib", "kernel", "queue.js"));
const resolution = require(path.join(ROOT, "lib", "kernel", "resolution.js"));

// Walk bounds: far past any real program, and still bounded. A walk that hits
// them is reported (`truncated`) and the loop never concludes "complete" or
// "halted" off a partial membership.
const WALK_DEPTH = 1000;
const WALK_NODES = 1000;
// POST /v1/nodes/batch takes at most 100 ids per logical request.
const BATCH_IDS = 100;

// membershipClosure(envelope) -> [{id, title, type, bucket}] in the envelope's
// BFS order: every row reached over a `member-of-program` edge whose parent is
// the root or itself a member. A fixpoint, because a node first sighted over a
// blocks-fallback row and only later over a membership row (a `repeat` row)
// has its own member rows listed under its FIRST sighting — earlier in the
// tree than the row that makes it a member.
function membershipClosure(envelope) {
  if (!envelope || !Array.isArray(envelope.tree)) return [];
  const rootId = envelope.root_id;
  const firstRow = new Map();
  for (const r of envelope.tree) if (r && r.id && !firstRow.has(r.id)) firstRow.set(r.id, r);
  const members = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of envelope.tree) {
      if (!r || !r.id || members.has(r.id) || r.id === rootId) continue;
      if (r.edge !== programKernel.MEMBERSHIP_EDGE) continue;
      if (r.parent !== rootId && !members.has(r.parent)) continue;
      members.add(r.id);
      changed = true;
    }
  }
  const out = [];
  for (const [id, r] of firstRow) {
    if (!members.has(id)) continue;
    out.push({ id, title: r.title ?? null, type: r.type ?? null, bucket: r.bucket || "open" });
  }
  return out;
}

// The snapshot both modes return:
//   {found: true, root_id, title, truncated, members: [{id, title, type,
//    bucket, status, human, blockers}]}
// `human` is the reason a person must act first (null when none) — the same
// derived readiness the queue computes (requires: human, assigned -> person,
// an open question nearby) where the graph is at hand, and the node's own
// declared `requires: human` / `assigned -> person-*` where only the node is.
// `blockers` names a member's live blockers where the graph is at hand (null
// when unknown). `agents` lists, remotely, the agents an `assigned` edge names
// — a claim writes one, so a member assigned to another box's agent is being
// worked there, not stuck (programStanding). `persons` is the same for an
// `assigned -> person-*` edge: a person's claim writes it too, so remotely it
// is NOT a human signal on its own — the queue says whether that person's
// lease is in force (the member is hidden) or the edge is mere routing (the
// member is visible, its derived readiness `human`)
// (issue-spor-work-program-standing-residual-edge-cases). Only members still
// OPEN are hydrated — a done member needs neither field.
function snapshotFromGraph(graph, rootId) {
  const envelope = programKernel.walkProgram(graph, rootId, { maxDepth: WALK_DEPTH, maxNodes: WALK_NODES });
  if (envelope.found === false) return { found: false, root_id: rootId };
  const resolvedBy = resolution.resolutionMap(graph);
  const blockersOf = queue.blockersIndex(graph);
  const members = membershipClosure(envelope).map((m) => {
    const node = graph.nodes[m.id];
    if (m.bucket === "done" || !node) return { ...m, status: node ? node.status ?? null : null, human: null, blockers: null, agents: [], persons: [] };
    const r = queue.deriveReadiness(graph, node, false, resolvedBy, true);
    return {
      ...m,
      status: node.status ?? null,
      // Local mode has no claims (no lease server writes an edge), so an
      // `assigned -> agent` (or `-> person`) here is routing, not someone else
      // working it — the derived readiness reads a person assignment as human.
      agents: [],
      persons: [],
      human: r.readiness === "human" ? r.reasons[0] || "needs a person" : null,
      blockers: queue.liveBlockers(graph, m.id, blockersOf, resolvedBy),
    };
  });
  return { found: true, root_id: rootId, title: envelope.root ? envelope.root.title : null, truncated: !!envelope.truncated, members };
}

// The node-only half of the readiness reading, for the remote arm (which has
// the node's frontmatter, not the graph around it). Never says "agent" — it
// only finds the hard human signals a node carries itself; the queue page's
// own derived readiness covers the rest when the item is on the page. An
// `assigned -> person-*` edge is NOT one of them: a person's claim writes the
// same edge, so it is read with the claims (`assignedTo`), and the queue's
// derived readiness still says `human` for a visible, merely-routed member.
function humanFromNode(fm) {
  if (!fm) return null;
  if (fm.type === "question") return "open question awaiting an answer";
  if (fm.type === "capture-pending") return "pending capture awaiting triage";
  if (queue.requiresList(fm).includes("human")) return "requires human";
  return null;
}

// The ids a node's `assigned` edges name under one prefix (`agent-` or
// `person-`), deduplicated in edge order.
function assignedTo(node, prefix) {
  const out = [];
  for (const e of Array.isArray(node && node.edges) ? node.edges : []) {
    if (e && e.type === "assigned" && typeof e.to === "string" && e.to.startsWith(prefix) && !out.includes(e.to)) out.push(e.to);
  }
  return out;
}

async function remoteSnapshot(cfg, rootId, { remote }) {
  const r = await remote.get(cfg, `/v1/program/${encodeURIComponent(rootId)}?format=envelope&depth=${WALK_DEPTH}&max_nodes=${WALK_NODES}`, { timeoutMs: 10000 });
  if (r.status === 404) return { found: false, root_id: rootId };
  if (r.transport || !r.ok) return { error: `GET /v1/program/${rootId} failed${r.status ? ` (${r.status})` : ""}` };
  const envelope = r.json;
  if (!envelope || envelope.found === false) return { found: false, root_id: rootId };
  if (!Array.isArray(envelope.tree)) return { error: "the server did not answer with the program envelope (?format=envelope) — it predates program-scoped work" };
  const members = membershipClosure(envelope);
  const open = members.filter((m) => m.bucket !== "done").map((m) => m.id);
  const fmById = new Map();
  for (let i = 0; i < open.length; i += BATCH_IDS) {
    let body = { ids: open.slice(i, i + BATCH_IDS) };
    for (;;) {
      const b = await remote.post(cfg, "/v1/nodes/batch", body, { timeoutMs: 10000 });
      if (b.transport || !b.ok || !b.json) return { error: `POST /v1/nodes/batch failed${b.status ? ` (${b.status})` : ""}` };
      for (const n of Array.isArray(b.json.nodes) ? b.json.nodes : []) {
        const fm = n && (n.frontmatter || n);
        const id = (n && n.id) || (fm && fm.id);
        if (id) fmById.set(id, fm);
      }
      if (!b.json.truncated || !b.json.next_cursor) break;
      body = { cursor: b.json.next_cursor };
    }
  }
  return {
    found: true,
    root_id: rootId,
    title: envelope.root ? envelope.root.title : null,
    truncated: !!envelope.truncated,
    members: members.map((m) => {
      const fm = fmById.get(m.id) || null;
      const done = m.bucket === "done";
      return { ...m, status: fm ? fm.status ?? null : null, human: done ? null : humanFromNode(fm), blockers: null, agents: done ? [] : assignedTo(fm, "agent-"), persons: done ? [] : assignedTo(fm, "person-") };
    }),
  };
}

// readProgramSnapshot(cfg, rootId, {remote, loadGraph}) -> a snapshot, or
// {found: false}, or {error} — never throws. `loadGraph` is injected so the
// local arm reads the same graph loader the rest of the CLI does.
async function readProgramSnapshot(cfg, rootId, { remote, loadGraph }) {
  try {
    if (cfg.mode() === "remote") return await remoteSnapshot(cfg, rootId, { remote });
    return snapshotFromGraph(loadGraph(cfg.nodesDir()), rootId);
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { membershipClosure, snapshotFromGraph, humanFromNode, readProgramSnapshot, WALK_DEPTH, WALK_NODES };
