"use strict";
// kernel/program.js — the program/progress view (task-spor-cli-program-verb).
// Local `spor program` walks it directly, and the server serves this same
// envelope from GET /v1/program/{id}?format=envelope / render_program
// format:"envelope" (dec-spor-server-serves-client-kernel-queue-and-program-
// envelopes), so it is THE program walk both modes render.
//
// Given a root node (an umbrella task, a milestone), walks its membership tree
// transitively and buckets each node from the SAME truth the queue uses
// (kernel/queue.js's isLive/liveBlockers, kernel/resolution.js's
// resolutionMap): a node retired by supersession, a terminal status, or a live
// resolves/answers edge is `done` (even while its status field lags); a live
// node gated by its own unresolved live blocker is `blocked`; the rest split
// `active` (status: active) vs `open`. Pure and deterministic — data in, data
// out, no I/O.
//
// MEMBERSHIP vs GATING (dec-spor-program-membership-dedicated-edge-type,
// dec-spor-program-membership-per-node-preference). At each node the walk
// prefers its inbound `member-of-program` edges when it has any, and otherwise
// falls back to its inbound `blocks` edges — per NODE, not per root, so a
// migrated hub over an unmigrated sub-hub still renders the whole subtree. A
// graph with no membership edges walks pure `blocks` and its envelope is
// byte-identical to before (every membership field below is additive and
// absent there). The preference is all-or-nothing at a node, so a
// half-migrated umbrella's remaining blockers are never dropped silently: they
// are reported in `outside`/`outside_ids` — blockers of a DECLARED node that
// are nowhere in the tree. Gating stays `blocks`-only: the `blocked` bucket is
// derived from inbound `blocks` edges, never from membership.

const queue = require("./queue.js");
const resolution = require("./resolution.js");

// The dedicated program-membership edge type, written member -> umbrella like
// `blocks` (its inverse spelling is flipped on write, so only this one is read).
const MEMBERSHIP_EDGE = "member-of-program";

// membersIndex[target] -> [sourceId, ...] over inbound `member-of-program`
// edges — queue.blockersIndex's shape; dangling targets are skipped.
function membersIndex(graph) {
  const out = {};
  for (const n of Object.values(graph.nodes)) {
    for (const e of n.edges ?? []) {
      if (e.type === MEMBERSHIP_EDGE && graph.nodes[e.to]) (out[e.to] ??= []).push(n.id);
    }
  }
  return out;
}

function bucketOf(graph, id, blockersOf, resolvedBy) {
  const n = graph.nodes[id];
  if (!queue.isLive(n, graph.supersededBy, graph) || resolvedBy[id]) return "done";
  if (queue.liveBlockers(graph, id, blockersOf, resolvedBy).length) return "blocked";
  return String(n.status || "").toLowerCase() === "active" ? "active" : "open";
}

// walkProgram(graph, rootId, {maxDepth, maxNodes}) -> the program envelope
// { found, root_id, root: {id, title, type}, progress: {total, done, active,
//   blocked, open, pct, statuses}, count, truncated, node_ids, tree }.
// `tree` is the flattened membership tree in BFS (shallowest-first) order: each
// row is { id, type, title, depth, parent, bucket, repeat }, depth 1 = a direct
// member (or, by fallback, blocker) of the root; a row reached over a
// `member-of-program` edge also carries `edge: "member-of-program"` (a
// blocks-reached row carries no `edge`, keeping a blocks-only envelope
// unchanged). A node reachable via more than one path is counted once (in
// `node_ids`/`progress`) but rendered again at each occurrence as a
// `repeat: true` leaf — it is never re-expanded past the first sighting, which
// also makes a cycle terminate rather than loop.
//
// Membership-only envelope fields, present only when they say something:
// `root_edge: "member-of-program"` when the root declares its members, and
// `outside` (count) + `outside_ids` (first-seen order) when a declared node in
// the tree is blocked by work that is nowhere in the tree (withheld on a
// truncated walk, which cannot tell).
//
// `maxDepth` (default 20) and `maxNodes` (default 200) bound the walk; hitting
// either caps expansion and sets `truncated: true` rather than silently
// under-counting. An unknown root returns `{ found: false, error:
// "unknown_root" }`; a root nothing blocks returns a successful empty result
// (`count: 0`) — the caller's cue to add `member-of-program` (or `blocks`)
// edges from the work under it.
function walkProgram(graph, rootId, { maxDepth = 20, maxNodes = 200 } = {}) {
  const root = graph.nodes[rootId];
  if (!root) return { found: false, error: "unknown_root", root_id: rootId };

  const blockersOf = queue.blockersIndex(graph);
  const membersOf = membersIndex(graph);
  const resolvedBy = resolution.resolutionMap(graph);

  const seen = new Map(); // id -> depth first seen at (BFS order = shallowest)
  const bucketById = new Map();
  const order = [];
  const tree = [];
  let truncated = false;

  const progress = { total: 0, done: 0, active: 0, blocked: 0, open: 0 };
  const statuses = {};

  // Candidate outside nodes: blockers of a DECLARED node that are not among its
  // own members. Reconciled against `seen` after the walk — a candidate that is
  // a member elsewhere in the tree (or the root) is not outside the program.
  const outsideCandidates = new Set();

  // The per-node preference: declared members when the node has any, else the
  // blocks-topology inference. Returns the child rows to enqueue.
  const childrenOf = (id, depth) => {
    const declared = membersOf[id];
    if (declared && declared.length) {
      const members = new Set(declared);
      for (const b of blockersOf[id] ?? []) if (!members.has(b)) outsideCandidates.add(b);
      return declared.map((cid) => ({ id: cid, depth, parent: id, edge: MEMBERSHIP_EDGE }));
    }
    return (blockersOf[id] ?? []).map((cid) => ({ id: cid, depth, parent: id }));
  };
  const row = (id, depth, parent, bucket, repeat, edge) =>
    edge
      ? { id, type: graph.nodes[id].type ?? null, title: graph.nodes[id].title ?? null, depth, parent, bucket, repeat, edge }
      : { id, type: graph.nodes[id].type ?? null, title: graph.nodes[id].title ?? null, depth, parent, bucket, repeat };

  const pending = childrenOf(rootId, 1);
  while (pending.length) {
    const { id, depth, parent, edge } = pending.shift();
    if (id === rootId) continue; // a cycle back to the root — never re-enter it

    if (seen.has(id)) {
      tree.push(row(id, depth, parent, bucketById.get(id), true, edge));
      continue; // shared blocker: rendered again here, already counted once
    }
    if (order.length >= maxNodes) {
      truncated = true;
      continue;
    }

    const node = graph.nodes[id];
    const bucket = bucketOf(graph, id, blockersOf, resolvedBy);
    seen.set(id, depth);
    bucketById.set(id, bucket);
    order.push(id);
    tree.push(row(id, depth, parent, bucket, false, edge));

    progress.total++;
    progress[bucket]++;
    const st = node.status || "(none)";
    statuses[st] = (statuses[st] ?? 0) + 1;

    const children = childrenOf(id, depth + 1);
    if (depth >= maxDepth) {
      if (children.length) truncated = true;
      continue;
    }
    pending.push(...children);
  }

  // A truncated walk cannot know "nowhere in the tree" (`seen` lacks exactly
  // the members past the cap), so it reports no outside items rather than
  // misnaming capped members — `truncated: true` already says the view is partial.
  const outsideIds = truncated ? [] : [...outsideCandidates].filter((id) => id !== rootId && !seen.has(id));

  return {
    found: true,
    root_id: rootId,
    root: { id: rootId, title: root.title ?? null, type: root.type ?? null },
    progress: { ...progress, pct: progress.total ? Math.round((progress.done / progress.total) * 100) : 0, statuses },
    count: order.length,
    truncated,
    node_ids: order,
    tree,
    ...(membersOf[rootId] && membersOf[rootId].length ? { root_edge: MEMBERSHIP_EDGE } : {}),
    ...(outsideIds.length ? { outside: outsideIds.length, outside_ids: outsideIds } : {}),
  };
}

module.exports = { walkProgram, MEMBERSHIP_EDGE };
