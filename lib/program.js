"use strict";
// program.js — the LOCAL arm of `spor program <id>` (task-spor-cli-program-verb):
// loads a local graph and walks it with kernel/program.js, plus the text
// renderer the local CLI arm prints through. The REMOTE arm (bin/spor.js
// programRemote) dispatches to GET /v1/program/{id} and prints the server's own
// rendering straight through (like `spor lens`) rather than re-deriving it here
// — the server's render_program view-tree shape is a separate, private
// implementation (see kernel/program.js's header), so there is no shared
// envelope to render generically across modes. This module only serves local
// mode.

const graphLib = require("./graph.js");
const kernel = require("./kernel/program.js");

// collect({nodesDir, rootId, maxDepth, maxNodes}) -> the program envelope
// (kernel/program.js's walkProgram). Throws whatever loadGraph throws on an
// unreadable/invalid local graph — callers should let that surface, same as
// compile.js/validate.js.
function collect({ nodesDir, rootId, maxDepth, maxNodes } = {}) {
  const graph = graphLib.loadGraph(nodesDir);
  return kernel.walkProgram(graph, rootId, {
    ...(maxDepth != null ? { maxDepth } : {}),
    ...(maxNodes != null ? { maxNodes } : {}),
  });
}

function bar(pct, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

// renderReport(envelope) -> human text. An unknown root reports the same one
// line the CLI's error path uses; an empty program (nothing blocks the root
// yet) says how to model one, matching render_program's own prose.
function renderReport(envelope) {
  if (!envelope || envelope.found === false) {
    return `program: unknown root '${envelope && envelope.root_id != null ? envelope.root_id : ""}'`;
  }
  const { root, progress, count, truncated, tree } = envelope;
  const label = root && root.title ? `${envelope.root_id} — ${root.title}` : envelope.root_id;
  const lines = [`program ${label}`];
  if (!count) {
    lines.push("  nothing blocks this node yet — add `blocks` edges from the gating tasks to model the program.");
    return lines.join("\n");
  }
  lines.push(
    `  ${bar(progress.pct)} ${progress.pct}%  ` +
      `(${progress.done}/${progress.total} done, ${progress.active} active, ${progress.blocked} blocked, ${progress.open} open)`
  );
  lines.push("");
  for (const row of tree) {
    const indent = "  ".repeat(row.depth);
    const bucket = row.bucket.padEnd(7);
    const title = row.title ? `  ${row.title}` : "";
    const marker = row.repeat ? "  (repeat, already counted)" : "";
    lines.push(`${indent}${bucket} ${row.id}${title}${marker}`);
  }
  if (truncated) lines.push("", "  (truncated — raise --max-depth/--max-nodes to see the rest)");
  return lines.join("\n");
}

module.exports = { collect, renderReport, bar };
