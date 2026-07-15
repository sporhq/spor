"use strict";
// kernel/program.js — the program/progress view over `blocks` topology
// (task-spor-cli-program-verb), the LOCAL-mode twin of the server's
// render_program MCP tool / GET /v1/program/{id} (API.md §3). The server's own
// kernel (lib-engine/kernel/program.js) lives in the private spor-server repo —
// a SEPARATE implementation behind the same contract, not shared code, so this
// is a from-scratch client-side walk, not a port.
//
// Given a root node other work `blocks` (an umbrella task, a milestone), walks
// its gating tree transitively over inbound `blocks` edges and buckets each
// node from the SAME truth the queue uses (kernel/queue.js's isLive/
// liveBlockers, kernel/resolution.js's resolutionMap): a node retired by
// supersession, a terminal status, or a live resolves/answers edge is `done`
// (even while its status field lags); a live node gated by its own unresolved
// live blocker is `blocked`; the rest split `active` (status: active) vs
// `open`. Pure and deterministic — data in, data out, no I/O.

const queue = require("./queue.js");
const resolution = require("./resolution.js");

function bucketOf(graph, id, blockersOf, resolvedBy) {
  const n = graph.nodes[id];
  if (!queue.isLive(n, graph.supersededBy) || resolvedBy[id]) return "done";
  if (queue.liveBlockers(graph, id, blockersOf, resolvedBy).length) return "blocked";
  return String(n.status || "").toLowerCase() === "active" ? "active" : "open";
}

// walkProgram(graph, rootId, {maxDepth, maxNodes}) -> the program envelope
// { found, root_id, root: {id, title, type}, progress: {total, done, active,
//   blocked, open, pct, statuses}, count, truncated, node_ids, tree }.
// `tree` is the flattened gating tree in BFS (shallowest-first) order: each row
// is { id, type, title, depth, parent, bucket, repeat }, depth 1 = a direct
// blocker of the root. A node reachable via more than one path is counted once
// (in `node_ids`/`progress`) but rendered again at each occurrence as a
// `repeat: true` leaf — it is never re-expanded past the first sighting, which
// also makes a `blocks` cycle terminate rather than loop.
//
// `maxDepth` (default 20) and `maxNodes` (default 200) bound the walk; hitting
// either caps expansion and sets `truncated: true` rather than silently
// under-counting. An unknown root returns `{ found: false, error:
// "unknown_root" }`; a root nothing blocks returns a successful empty result
// (`count: 0`) — the caller's cue to add `blocks` edges from the gating work.
function walkProgram(graph, rootId, { maxDepth = 20, maxNodes = 200 } = {}) {
  const root = graph.nodes[rootId];
  if (!root) return { found: false, error: "unknown_root", root_id: rootId };

  const blockersOf = queue.blockersIndex(graph);
  const resolvedBy = resolution.resolutionMap(graph);

  const seen = new Map(); // id -> depth first seen at (BFS order = shallowest)
  const bucketById = new Map();
  const order = [];
  const tree = [];
  let truncated = false;

  const progress = { total: 0, done: 0, active: 0, blocked: 0, open: 0 };
  const statuses = {};

  const pending = (blockersOf[rootId] ?? []).map((id) => ({ id, depth: 1, parent: rootId }));
  while (pending.length) {
    const { id, depth, parent } = pending.shift();
    if (id === rootId) continue; // a blocks-cycle back to the root — never re-enter it

    if (seen.has(id)) {
      tree.push({ id, type: graph.nodes[id].type ?? null, title: graph.nodes[id].title ?? null, depth, parent, bucket: bucketById.get(id), repeat: true });
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
    tree.push({ id, type: node.type ?? null, title: node.title ?? null, depth, parent, bucket, repeat: false });

    progress.total++;
    progress[bucket]++;
    const st = node.status || "(none)";
    statuses[st] = (statuses[st] ?? 0) + 1;

    const children = blockersOf[id] ?? [];
    if (depth >= maxDepth) {
      if (children.length) truncated = true;
      continue;
    }
    for (const cid of children) pending.push({ id: cid, depth: depth + 1, parent: id });
  }

  return {
    found: true,
    root_id: rootId,
    root: { id: rootId, title: root.title ?? null, type: root.type ?? null },
    progress: { ...progress, pct: progress.total ? Math.round((progress.done / progress.total) * 100) : 0, statuses },
    count: order.length,
    truncated,
    node_ids: order,
    tree,
  };
}

module.exports = { walkProgram };
