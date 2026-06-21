// analytics.js — façade + CLI over the pure work-analytics kernel
// (task-spor-work-analytics-consumer). The kernel (lib/kernel/analytics.js) does
// the status-timeline fold and the created-vs-completed aggregation; this façade
// resolves the git status-transition log (lib/shell/gittime.js) and the terminal
// vocabulary, then renders. Mirrors lib/queue.js / lib/query.js: a thin host
// layer plus a local-mode CLI. Zero deps.
//
// Also a CLI (local mode / debugging):
//   node lib/analytics.js [--nodes <dir>] [--project <slug>]
//     [--type <T> ...]   restrict to these node types (repeatable, comma-ok)
//     [--weeks <n>]      weekly-cohort window length (default 12)
//     [--top <n>]        bottleneck list length (default 10)
//     [--aging <n>]      aging-WIP / bottleneck age threshold in days (default 30)
//     [--json]           machine-readable report

const kernel = require("./kernel/analytics.js");
const resolution = require("./kernel/resolution.js");

// analyze(graph, opts) -> report. The façade derives the git status-transition
// completion map (the constraint's primary completion signal) and the terminal
// predicate, then defers to the pure kernel. graph.timestamps is the lazy git-
// derived index (task-spor-git-derived-timestamp-index); reading it here is what
// triggers the cache-backed fold, and it stays OFF the no-LLM prompt path.
//   opts: { now?, weeks?, types?, agingDays?, topN?, inScope? }
function analyze(graph, opts = {}) {
  const gittime = require("./shell/gittime.js");
  const path = require("path");
  // The status-transition fold needs the graph's git repo + nodes pathspec.
  let gitClosed = {};
  if (graph.nodesDir) {
    const repoDir = path.dirname(graph.nodesDir);
    const nodesName = path.basename(graph.nodesDir);
    const log = gittime.logStatusTransitions(repoDir, nodesName); // null = fail-open
    gitClosed = kernel.foldStatusTransitions(log, nodesName, resolution.isTerminalStatus);
  }
  return kernel.computeAnalytics({
    nodes: graph.nodes,
    timestamps: graph.timestamps,
    gitClosed,
    supersededBy: graph.supersededBy || {},
    isTerminal: resolution.isTerminalStatus,
    now: opts.now ?? Date.now(),
    weeks: opts.weeks ?? 12,
    typeSet: opts.types && opts.types.length ? new Set(opts.types) : null,
    inScope: opts.inScope ?? null,
    agingDays: opts.agingDays ?? 30,
    topN: opts.topN ?? 10,
  });
}

// Render the report as a human-readable text block (returned, not printed, so the
// CLI and any caller share one renderer). Sparkline-free, plain columns.
function renderReport(r) {
  const lines = [];
  const w = r.window;
  lines.push(`Work analytics · ${w.fromWeek} → ${w.toWeek} (${w.weeks} weeks) · as of ${w.now.slice(0, 10)}`);
  if (!r.coverage.hasTimestamps) {
    lines.push("(no git-derived timestamps — non-git graph home; cohorts fall back to frontmatter dates)");
  }
  lines.push("");
  // Weekly cohort table.
  lines.push("  week        created  completed     net   open");
  for (const wk of r.weekly) {
    const net = wk.net > 0 ? `+${wk.net}` : `${wk.net}`;
    lines.push(
      `  ${wk.week.padEnd(10)}  ${String(wk.created).padStart(7)}  ${String(wk.completed).padStart(9)}  ${net.padStart(6)}  ${String(wk.backlog).padStart(5)}`
    );
  }
  lines.push("");
  // Summary.
  const ct = r.cycleTimeDays;
  lines.push(`  window:     ${r.totals.created} created, ${r.totals.completed} completed (net ${r.totals.net >= 0 ? "+" : ""}${r.totals.net})`);
  lines.push(`  throughput: ${r.throughput.perWeek} completed/week`);
  lines.push(`  cycle time: ${ct.median == null ? "—" : `${ct.median}d median, ${ct.p90}d p90`} (n=${ct.count})`);
  // WIP by type.
  const types = Object.keys(r.wip.byType).sort((a, b) => r.wip.byType[b] - r.wip.byType[a]);
  const wipStr = types.length ? types.map((t) => `${t} ${r.wip.byType[t]}`).join(", ") : "none";
  lines.push(`  open WIP:   ${r.wip.open} (${r.wip.aging} aging ≥${r.wip.agingDays}d) — ${wipStr}`);
  // Bottlenecks.
  if (r.bottlenecks.length) {
    lines.push("");
    lines.push(`  oldest open (bottlenecks):`);
    for (const b of r.bottlenecks) {
      lines.push(`    ${String(b.ageDays).padStart(4)}d  ${b.id}  (${b.type}${b.status ? `, ${b.status}` : ""})`);
    }
  }
  // Coverage footnote: how completion times were sourced (the constraint matters,
  // so make the git-vs-fallback split visible — a high fallback share warns the
  // weekly "completed" buckets are approximate).
  const cov = r.coverage;
  lines.push("");
  lines.push(`  completion source: ${cov.fromGitTransition} git status-transition, ${cov.fromFallback} fallback (of ${cov.completedInWindow} completed in window)`);
  return lines.join("\n");
}

module.exports = { analyze, renderReport };

// ---------- CLI (local mode / debugging) ----------

if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const graphLib = require(path.join(__dirname, "graph.js"));

  const argv = process.argv.slice(2);
  const opt = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d;
  };
  // Repeatable + comma-splittable, mirroring lib/queue.js's multi().
  const multi = (n) => {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === `--${n}` && argv[i + 1] != null) {
        out.push(...argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean));
      }
    }
    return out;
  };

  const cfg = require(path.join(__dirname, "config.js")).loadConfig({ cwd: process.cwd() });
  const NODES_DIR = path.resolve(opt("nodes", cfg.nodesDir()));
  if (!fs.existsSync(NODES_DIR)) {
    console.error(`no Spor graph at ${NODES_DIR}`);
    process.exit(0);
  }
  const g = graphLib.loadGraph(NODES_DIR);

  // Project scope (reusing the queue's shared resolver): a bare slug resolves to
  // its home-grouping union, a repo-<slug>/grouping id pins it. Warn (fail-open,
  // exit 0) on a token that matches nothing, exactly like `spor next`.
  const project = opt("project", null);
  let inScope = null;
  if (project) {
    if (!graphLib.projectKnown(g, project)) {
      console.error(`project '${project}' matched no repo or grouping — analytics is empty (try a repo slug, a repo-<slug> node id, or a grouping id)`);
    }
    const scope = graphLib.scopeFor(g, project);
    inScope = (node) => scope.has(graphLib.resolveProject(g, node.project));
  }

  const report = analyze(g, {
    weeks: parseInt(opt("weeks", "12"), 10) || 12,
    topN: parseInt(opt("top", "10"), 10) || 10,
    agingDays: parseInt(opt("aging", "30"), 10) || 30,
    types: multi("type"),
    inScope,
  });

  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    console.log(renderReport(report));
  }
}
