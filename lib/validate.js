#!/usr/bin/env node
// Spor validate — lint a Spor graph. Thin CLI wrapper over
// lib/graph.js (validateGraph). All rules live in graph.js.
// Usage: validate.js [--nodes <dir>] [--summary] [--json]
// Errors (exit 1): unparseable file, missing id/type/title/summary, id != filename,
// duplicate id, correction without target.
// Warnings (exit 0): dangling edge, unknown edge type, unknown node type, missing date,
// body approaching/over the server's 8KB cap. The approaching-the-cap warning is
// asked for HERE and by no other caller (nearBodyCap): this pass is the one a
// running log's owner is told to run periodically (the SessionEnd distiller also
// spawns it, logging to journal/distill.log), while the gardener's graph-wide
// sweep files a queue finding per warning and must not be handed one that a
// finished node can never clear.
//
// --summary / --json (task-spor-cli-remote-validate-summary) are the whole-graph
// sanity READ a backfill wants after the fact — counts by type, warnings tallied
// by kind (dangling edges, unknown types, …), and orphans — without paging
// through thousands of WARN lines. `spor validate` in remote mode runs this same
// file over the team graph fetched via GET /v1/export, so the summary is the
// gardener's own lint (validateGraphFiles) computed on demand, not a sweep.
// Orphans are INFORMATIONAL, never warnings: the gardener files a finding per
// warning, and a schema or person node with no edges is not a defect. Without
// either flag the output is byte-identical to before.

const path = require("path");
const graph = require(path.join(__dirname, "graph.js"));

const argv = process.argv.slice(2);
const i = argv.indexOf("--nodes");
const home = require(path.join(__dirname, "shell", "home.js"));
// Client config cascade (dec-spor-client-config-cascade): nodesDir() honors
// config.nodes / SPOR_NODES then the graph-home default — byte-identical when
// no config is set.
const cfg = require(path.join(__dirname, "config.js")).loadConfig({ cwd: process.cwd() });
const NODES_DIR = path.resolve(i >= 0 ? argv[i + 1] : cfg.nodesDir());

// Surface client-config issues (typo'd keys, a secret in a committable repo
// config) on stderr so the stdout node-count contract is unchanged — empty when
// no config files are present, so conformance stays byte-identical.
for (const w of cfg.warnings) console.error(`config: ${w}`);

// validateGraph re-reads the directory itself (tolerating malformed files that
// loadGraph would throw on), so pass the dir rather than a parsed graph. A
// missing NODES_DIR (e.g. this direct entry run on a remote-mode machine with
// no local ~/.spor/nodes — `spor validate` handles that case itself by
// fetching the team graph first, see bin/spor.js cmdValidate) otherwise
// surfaces as a raw ENOENT stack from readdirSync deep in shell/files.js;
// catch it here and point at the command that actually works instead
// (issue-spor-validate-enoent-remote-no-local-nodes). Matched narrowly —
// syscall + path — so this doesn't also swallow an ENOENT from something
// else validateGraph touches (a node file raced away between readdirSync
// and readFileSync since this call passes no onSkip, or a broken/partial
// install missing lib/seed/): those are real faults with a different cause
// and must still throw loud, not get relabeled as "no local graph".
let result;
try {
  result = graph.validateGraph(NODES_DIR, { nearBodyCap: true });
} catch (e) {
  if (e && e.code === "ENOENT" && e.syscall === "scandir" && e.path === NODES_DIR) {
    console.error(`no local graph at ${NODES_DIR}; in remote mode run \`spor validate\``);
    process.exit(1);
  }
  throw e;
}
const { errors, warnings, byType, count, nodes } = result;
const typeLine = `${count} nodes (${Object.entries(byType).map(([t, c]) => `${c} ${t}`).join(", ")})`;

if (argv.includes("--summary") || argv.includes("--json")) {
  const kinds = tallyKinds(warnings);
  const orphans = findOrphans(nodes);
  const orphansByType = {};
  for (const n of orphans) orphansByType[n.type] = (orphansByType[n.type] ?? 0) + 1;
  if (argv.includes("--json")) {
    console.log(JSON.stringify({
      count, byType,
      errors, warnings,
      warnings_by_kind: kinds,
      orphans: { count: orphans.length, byType: orphansByType, ids: orphans.map((n) => n.id) },
    }, null, 2));
  } else {
    console.log(typeLine);
    const tally = (o) => Object.entries(o).map(([k, c]) => `${c} ${k}`).join(", ");
    console.log(`warnings by kind: ${warnings.length ? tally(kinds) : "none"}`);
    console.log(`orphans: ${orphans.length}${orphans.length ? ` (${tally(orphansByType)})` : ""}`);
    for (const e of errors) console.log(`ERROR ${e}`);
    console.log(`${errors.length} errors, ${warnings.length} warnings`);
  }
  process.exit(errors.length ? 1 : 0);
}

console.log(typeLine);
for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(`${errors.length} errors, ${warnings.length} warnings`);
process.exit(errors.length ? 1 : 0);

// Bucket each warning by what it reports, keyed off the message after its
// `<file>: ` / `registry: ` prefix. Order-preserving (first-seen); an
// unrecognized message lands in `other` so a new warning is still counted.
function tallyKinds(ws) {
  const KINDS = [
    ["registry", /^registry: /],
    ["dangling-edge", /: dangling edge /],
    ["unknown-edge-type", /: unknown edge type /],
    ["unknown-type", /: unknown type /],
    ["missing-date", /: missing date$/],
    ["body-cap", /: body is \d+B, /],
    ["superseded-without-replacement", /: status superseded but no node supersedes it/],
    ["norm-selector", /: applies_to_\w+ /],
    ["coupling", /: (coupling keys|couples_)/],
  ];
  const out = {};
  for (const w of ws) {
    const hit = KINDS.find(([, re]) => re.test(w));
    const k = hit ? hit[0] : "other";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// A node is an orphan when nothing RESOLVABLE connects it: none of its own
// edges reaches a node in the graph, and no node's edge reaches it. A dangling
// edge is not a connection (its target is missing), so a node whose only edge
// dangles still counts — except a person's `stewards -> <rootId>`, the virtual
// graph-wide operator anchor the lint already exempts (lib/graph.js
// validateGraph resolves the same SPOR_ROOT_ID) — and a correction's `target:`
// is its link to the briefing it corrects, so it connects like an edge.
// Directory order, like every other list here.
function findOrphans(ns) {
  const rootId = process.env.SPOR_ROOT_ID || "org-root";
  const linked = new Set();
  for (const n of Object.values(ns)) {
    if (n.type === "correction" && n.target && n.target !== n.id && ns[n.target]) {
      linked.add(n.id);
      linked.add(n.target);
    }
    for (const e of n.edges) {
      if (e.type === "stewards" && e.to === rootId) { linked.add(n.id); continue; }
      if (e.to === n.id || !ns[e.to]) continue;
      linked.add(n.id);
      linked.add(e.to);
    }
  }
  return Object.values(ns).filter((n) => !linked.has(n.id));
}
