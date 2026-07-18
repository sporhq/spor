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

// A node type's OWN declared `status.terminal` partition — graph.registry is
// the one place this is looked up (dec-cc-registry-as-data): the per-type
// overload of Registry.terminalStatuses(type), mirroring inertStatuses(type)'s
// per-type shape for the sibling status.inert partition. Empty for an unknown
// type, a graph with no registry, or a schema declaring no status.terminal.
function ownTerminalStatuses(graph, type) {
  const reg = graph.registry;
  return reg && typeof reg.terminalStatuses === "function" && type ? reg.terminalStatuses(type) : new Set();
}

// The analytics completion predicate: resolution.js's legacy type-blind TERMINAL
// set (universal completion words) UNIONED, PER NODE, with that node's OWN TYPE's
// declared status.terminal (task-spor-analytics-type-aware-inert-partition,
// issue-spor-analytics-completion-ignores-schema-terminal-status). Type-aware —
// NOT the old flat cross-type union, which leaked one type's declared status
// (artifact `released`) into how EVERY type was judged, so a mislabeled
// non-artifact carrying `released` was silently counted complete. A schema-only
// lifecycle-terminal status with no declared `status.inert` (decision `settled`)
// still counts as analytics completion here — this is the node's OWN-lifecycle
// partition (status.terminal), distinct from the type-aware QUEUE-liveness
// partition (status.inert / resolution.isTerminalStatus) that deliberately keeps
// a settled decision live in queues and briefings
// (dec-spor-decision-lifecycle-surfacing). Returns `(status, id) => boolean`,
// the shape both the kernel's git-content fold and computeAnalytics's retired
// check call — so a type-scoped terminal status also gets an accurate
// git-transition completion date, not just a fallback one. Per-type results are
// memoized for the life of one analyze() call.
function terminalPredicate(graph) {
  const blind = new Set(resolution.terminalStatuses);
  const perType = new Map(); // type -> Set (blind ∪ that type's own status.terminal)
  return (status, id) => {
    const s = (status || "").toLowerCase();
    if (blind.has(s)) return true;
    const type = graph.nodes[id] && graph.nodes[id].type;
    if (!type) return false;
    let own = perType.get(type);
    if (!own) {
      own = ownTerminalStatuses(graph, type);
      perType.set(type, own);
    }
    return own.has(s);
  };
}

// The closed-at cache's fingerprint (task-spor-analytics-closed-at-cache): the
// type-blind fallback plus, for every node type the registry declares, a
// `<type>:<sorted values>` segment for that type's OWN status.terminal — so a
// seed upgrade or resident schema override that changes ANY type's terminal
// partition invalidates a cache whose folded state baked in the old
// vocabulary. A flat cross-type union of values would miss a value MOVING
// between two types' declarations (the set of distinct strings is unchanged
// even though which types it applies to is), so the fingerprint must be
// keyed per-type, not just on the union of values.
function terminalFingerprint(graph) {
  const reg = graph.registry;
  const types = reg && reg.nodeSchemas ? [...reg.nodeSchemas.keys()].sort() : [];
  const parts = [...resolution.terminalStatuses];
  for (const type of types) {
    const own = ownTerminalStatuses(graph, type);
    if (own.size) parts.push(`${type}:${[...own].sort().join("|")}`);
  }
  return parts.join(",");
}

// Resolve the git status-transition completion map { id: closedAtISO }, cache-
// backed and (HEAD + terminal-vocabulary)-keyed (task-spor-analytics-closed-at-
// cache), mirroring graph.js deriveTimestamps. `isTerminal`/`fp` are the analytics
// terminal predicate and its fingerprint (terminalPredicate/terminalFingerprint
// below), both derived by the caller from the SAME graph so the fold and the
// cache key share one vocabulary. An exact-HEAD+fp hit reuses the cached per-node fold
// state with NO `git log -p`; a cached HEAD that is an ancestor of current folds
// only OLD..NEW and composes onto the cached state (the forward status walk is
// range-composable); a history rewrite, a vocabulary change, or a cold/torn cache
// does a full rebuild. The cache lives beside timestamps.json under the gitignored
// cache/ dir and stores the per-node STATE (not the closed-at output) so the
// incremental fold can continue the walk. Fail-open like graph.js's gitFront: a
// non-git home or a failed `git log` returns the best available map and NEVER
// poisons the cache with a transient empty result (a torn read would otherwise
// stick across exact-HEAD hits).
function deriveStatusTransitions(graph, isTerminal, fp) {
  if (!graph.nodesDir) return {};
  const gittime = require("./shell/gittime.js");
  const path = require("path");
  const repoDir = path.dirname(graph.nodesDir);
  const nodesName = path.basename(graph.nodesDir);
  const cacheDir = path.join(repoDir, "cache");
  const head = gittime.gitHead(repoDir);
  if (!head) return {}; // non-git home -> no transition history (created/superseded fallback)
  const cached = gittime.readClosedCache(cacheDir);
  const reusable = !!cached && cached.fp === fp; // a vocabulary change forces a full rebuild
  if (reusable && cached.head === head) {
    return kernel.statusTransitionsFromState(cached.state); // exact HEAD+fp -> no git log -p
  }
  let state;
  if (reusable && gittime.isAncestor(repoDir, cached.head, head)) {
    const log = gittime.logStatusTransitions(repoDir, nodesName, `${cached.head}..${head}`);
    if (log === null) return kernel.statusTransitionsFromState(cached.state); // range read failed -> cached base, don't poison
    state = kernel.foldStatusTransitionState(log, nodesName, isTerminal, cached.state);
  } else {
    const log = gittime.logStatusTransitions(repoDir, nodesName); // full history
    if (log === null) return {}; // full read failed -> fail-open empty, don't cache
    state = kernel.foldStatusTransitionState(log, nodesName, isTerminal, null);
  }
  gittime.writeClosedCache(cacheDir, head, fp, state);
  return kernel.statusTransitionsFromState(state);
}

// analyze(graph, opts) -> report. The façade derives the git status-transition
// completion map (the constraint's primary completion signal) and the terminal
// predicate, then defers to the pure kernel. graph.timestamps is the lazy git-
// derived index (task-spor-git-derived-timestamp-index); reading it here is what
// triggers the cache-backed fold, and it stays OFF the no-LLM prompt path.
//   opts: { now?, weeks?, types?, agingDays?, topN?, inScope? }
function analyze(graph, opts = {}) {
  // One type-aware predicate drives BOTH the fold and the kernel's `retired`
  // test, so a type-scoped terminal status (artifact `released`) gets an
  // accurate git-transition completion date, not just a fallback one
  // (task-spor-analytics-type-aware-inert-partition). The cache fingerprint
  // keys on the SAME per-type vocabulary, so a seed or resident partition
  // change invalidates a cache whose folded state baked in the old one.
  const isTerminal = terminalPredicate(graph);
  const fp = terminalFingerprint(graph);
  const gitClosed = deriveStatusTransitions(graph, isTerminal, fp); // cache-backed, HEAD+fp-keyed
  // Nodes retired by a live resolves/answers edge while their own status still
  // lags open (lib/kernel/resolution.js, task-spor-analytics-resolution-edge-
  // completion): { targetId: resolverId }. The kernel folds these into the
  // completed cohort, dated at the resolver's git created_at — closing the gap
  // where a structurally-done node sits in WIP only because its status lags.
  const resMap = resolution.resolutionMap(graph);
  const resolvedBy = {};
  for (const id of Object.keys(resMap)) resolvedBy[id] = resMap[id].by;

  return kernel.computeAnalytics({
    nodes: graph.nodes,
    timestamps: graph.timestamps,
    gitClosed,
    supersededBy: graph.supersededBy || {},
    resolvedBy,
    isTerminal,
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
  if (cov.fromResolutionEdge) {
    lines.push(`    (${cov.fromResolutionEdge} retired by a live resolves/answers edge while status still lagged open)`);
  }
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
