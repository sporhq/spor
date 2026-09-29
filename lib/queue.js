// queue.js — façade + CLI over the pure queue kernel (REFACTOR.md §1
// kernel/shell split; QUEUE.md §4/§5). This path is the stable import; the
// ranking lives in lib/kernel/queue.js. The façade's only job is host
// defaults: the zero-dep node:vm sandbox engine for attached code when the
// caller injects none (the server passes its hardened wasm engine instead).
//
// Also a CLI (local mode / debugging):
//   node lib/queue.js [--nodes <dir>] [--project <slug>] [--assignee <person-id>]
//                     [--type <t>] [--exclude-type <t>] [--readiness <c>] [--limit <n>]
//                     [--days <n>] [--no-front] [--json]
// --type / --exclude-type / --readiness are repeatable and comma-splittable
// (--type task,issue; --readiness agent,untriaged).

const kernel = require("./kernel/queue.js");
const { gitSpawn } = require("./shell/git-exec.js");

function rankQueue(graph, opts = {}) {
  return kernel.rankQueue(graph, {
    ...opts,
    // lazy: sandbox.js (node:vm) loads only if attached code actually runs
    sandboxFor: opts.sandboxFor ?? ((schema) => require("./sandbox.js").sandboxFor(schema)),
  });
}

// Local-mode `front` from git (task-cc-local-front-productionize). A node's
// `front` signal is viewer-scoped write-class activity over the last `days`
// (dec-cc-queue-front-from-attribution) — REMOTE mode reads it from the request
// log keyed by token identity. LOCAL mode has no request log, but the graph home
// IS a git repo the distiller auto-commits into, the local git author email IS
// the identity, and a commit touching nodes/<id>.md IS a write-class op on that
// node. So we reconstruct the same {nodeId: count} map from `git log`: commits
// authored by this identity, in the window, that added/modified/renamed a node
// file. Pure-delete commits are excluded (--diff-filter=ACMR) — a removed node
// isn't live work. No neighborhood spread (front never propagates), matching the
// server's writeActivity(). Best-effort + fail-open like every other hook path:
// not a git repo, no commits, or an unset user.email -> {} -> front 0 everywhere
// (the pre-front behavior). It feeds `front`, not `heat`: for a solo graph the
// two nearly coincide, and front is the honest viewer-scoped signal. The window
// and the on/off toggle live in the config cascade (queue.front.days /
// queue.front.enabled); the CLI flags --days/--no-front map onto them.
// The local git identity (`git config user.email`) of a repo, trimmed, or "" on
// any failure (not a git repo, no identity, missing binary). This IS the local
// $viewer comparand (dec-viewer-token-binding's local analogue: remote derives
// $viewer from the authenticated token, local derives it from git config) — the
// same read gitFront already did for front attribution, factored out so the
// viewer wiring and the front map share one source of truth. Best-effort +
// fail-open like every other local-mode path.
// Env-scrubbed (gitSpawn, shell/git-exec.js) so an ambient GIT_DIR/GIT_WORK_TREE/
// GIT_COMMON_DIR can't misdirect this identity read at a different repo
// (issue-spor-gittime-git-env-inheritance).
function gitIdentityEmail(repoDir) {
  const r = gitSpawn(repoDir, ["config", "user.email"], { stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? (r.stdout || "").trim() : "";
}

// Resolve a git email to the graph's `type: person` node by matching its
// `email:` field (trim + case-insensitive). The LOCAL analogue of
// dec-viewer-token-binding: remote binds $viewer from the authenticated token's
// email, local binds it from `git config user.email` — identity derives ONLY
// from git config, never from a caller-supplied parameter. Returns the person
// node, or null when there is no email / no match — so an unbound identity
// simply mutes nothing (activeMutes(null) is the empty set, byte-identical to a
// queue read with no viewer).
function viewerFor(graph, email) {
  const want = String(email || "").trim().toLowerCase();
  if (!want) return null;
  for (const n of Object.values(graph.nodes)) {
    if (n.type !== "person") continue;
    if (typeof n.email === "string" && n.email.trim().toLowerCase() === want) return n;
  }
  return null;
}

function gitFront(repoDir, nodesName, days) {
  const out = {};
  const run = (args) => {
    const r = gitSpawn(repoDir, args, { stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 ? r.stdout : null;
  };
  const email = gitIdentityEmail(repoDir);
  // --author is a regex matched against name OR email; anchor the email so a
  // substring of another author's line can't false-match. Unset identity ->
  // unfiltered (still useful on a graph committed under mixed identities,
  // just not viewer-scoped). Window uses git approxidate, matching the
  // server's 7-day default.
  const args = ["log", `--since=${days} days ago`, "--name-only", "--diff-filter=ACMR", "--pretty=format:"];
  if (email) args.push(`--author=<${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`);
  const log = run([...args, "--", `${nodesName}/`]);
  if (log == null) return out;
  const re = new RegExp(`^${nodesName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([a-z0-9][a-z0-9-]*)\\.md$`);
  // Each commit lists a touched file once, so occurrences across the log =
  // the number of commits that touched that node = its write-class count.
  for (const line of log.split("\n")) {
    const m = re.exec(line.trim());
    if (m) out[m[1]] = (out[m[1]] ?? 0) + 1;
  }
  return out;
}

// renderReport(envelope, { hidden }) -> the human queue text, the ONE renderer
// both modes print through (task-spor-local-remote-single-renderer-conformance):
// local `spor next` renders the envelope it shaped over a local graph, remote
// renders GET /v1/queue's body — so the same graph reads the same in either
// mode, and a line added here lands in both. `hidden` is the client-side
// --hide-dispatched count (the server cannot see this box's runs). Every
// demotion the envelope counts is printed, so no hiding is ever silent.
function renderReport(q, { hidden = 0 } = {}) {
  const items = (q && q.items) || [];
  const lines = [];
  if (!items.length) lines.push("queue empty — nothing queueable and live");
  for (const [i, it] of items.entries()) {
    lines.push(`${i + 1}. [${it.score}] ${it.id} — ${it.title} (${it.type}${it.status ? `, ${it.status}` : ""}${it.suggest === "close" ? ", suggest: close" : ""})`);
    if (it.why) lines.push(`   ${it.why}`); // the kernel always sets one; tolerate a server that omits it
  }
  // count is the full ranked total; with --limit 0 every item is on the page,
  // so this stays silent.
  if (q && typeof q.count === "number" && q.count > items.length) {
    lines.push(`(${q.count - items.length} more — raise --limit, or --limit 0 for all)`);
  }
  if (q && q.muted > 0) lines.push(`(${q.muted} muted — your queue_mute)`);
  // Blocked items gated out of the actionable queue (dec-spor-queue-hide-blocked).
  if (q && q.blocked > 0) lines.push(`(${q.blocked} blocked — gated by live work, hidden until unblocked)`);
  // Agent-readiness breakdown (dec-spor-agent-readiness-derived-classification):
  // present only when the kernel emits counts_by_readiness (the graph carries
  // readiness signal, or a --readiness facet was asked for).
  if (q && q.counts_by_readiness) {
    const c = q.counts_by_readiness;
    lines.push(`readiness: ${c.agent} agent-ready, ${c.human} need human, ${c.untriaged} untriaged`);
  }
  if (hidden > 0) lines.push(`(${hidden} in-flight hidden — --hide-dispatched)`);
  return lines.join("\n");
}

module.exports = {
  rankQueue, warmQueueIndex: kernel.warmQueueIndex, gitFront, gitIdentityEmail, viewerFor, PRIORITY_BUMP: kernel.PRIORITY_BUMP, DEFAULT_LIMIT: kernel.DEFAULT_LIMIT,
  shapeQueueEnvelope: kernel.shapeQueueEnvelope, queueAggregates: kernel.queueAggregates, SERVER_ONLY_QUEUE_FIELDS: kernel.SERVER_ONLY_QUEUE_FIELDS,
  renderReport,
};

// ---------- CLI (local mode / debugging; new entry point, existing CLIs untouched) ----------

if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const graphLib = require(path.join(__dirname, "graph.js"));

  const argv = process.argv.slice(2);
  const opt = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d;
  };
  // Repeatable + comma-splittable flag (task-cc-queue-filtering-enhancements):
  // `--type task --type issue` and `--type task,issue` both yield ["task","issue"].
  // null when the flag is absent so the kernel filter stays inert (byte-identical).
  const multi = (n) => {
    const out = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === `--${n}` && argv[i + 1] != null) {
        out.push(...argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean));
      }
    }
    return out.length ? out : null;
  };
  const home = require(path.join(__dirname, "shell", "home.js"));
  // Client config cascade (dec-spor-client-config-cascade); nodesDir() honors
  // config.nodes / SPOR_NODES then the graph-home default — byte-identical when
  // no config is set.
  const cfg = require(path.join(__dirname, "config.js")).loadConfig({ cwd: process.cwd() });
  const NODES_DIR = path.resolve(opt("nodes", cfg.nodesDir()));
  if (!fs.existsSync(NODES_DIR)) {
    console.error(`no Spor graph at ${NODES_DIR}`);
    process.exit(0);
  }
  const g = graphLib.loadGraph(NODES_DIR);
  // Local `front` from git (task-cc-local-front-productionize). The window and
  // the on/off toggle resolve through the config cascade
  // (queue.front.{days,enabled}); CLI flags are the highest-precedence layer, so
  // --days <n> overrides the window and --no-front forces it off. With front
  // disabled the front map is null -> front 0 everywhere -> byte-identical to the
  // pre-front ordering. Keyed off the dir that actually holds the nodes, so a
  // --nodes override or non-default layout still finds the right repo + pathspec.
  const days = argv.includes("--days")
    ? parseInt(opt("days", String(cfg.getNum("queue.front.days", 7))), 10)
    : cfg.getNum("queue.front.days", 7);
  const frontOn = !argv.includes("--no-front") && cfg.getBool("queue.front.enabled", true);
  const front = frontOn ? gitFront(path.dirname(NODES_DIR), path.basename(NODES_DIR), days) : null;
  // Local $viewer binding (issue-spor-local-mode-queue-mute-noop): per-viewer
  // queue_mute was dead locally because no viewer was ever constructed, so
  // activeMutes(undefined) was always empty. Resolve the git identity to its
  // person node (viewerFor) and pass it through — the kernel already honors
  // viewer.queue_mute. null when the identity matches no person node, so a graph
  // with no person nodes (or an unmatched identity) is byte-identical to the
  // pre-viewer read (no mutes, no muted count).
  const viewer = viewerFor(g, gitIdentityEmail(path.dirname(NODES_DIR)));
  const project = opt("project", null);
  // Git-derived per-node timestamp index (task-spor-git-derived-timestamp-index):
  // graph.timestamps is a lazy getter, so reading it here triggers the (cache-
  // backed) git fold for the queue path only — never the no-LLM prompt path. null
  // on a non-git home -> the cold_neighbors signal stays inert (byte-identical).
  // --limit 0 means "all" (task-spor-next-limit-flag). The kernel slices
  // items.slice(0, Math.max(0, limit)), so a literal 0 would render an EMPTY
  // page; translate it to Infinity HERE in the façade (slice(0, Infinity) ->
  // every ranked item, and count == items.length so no overflow line). Never in
  // the kernel — its slice contract is byte-identical-guarded and the server
  // relies on it. Any other value (incl. the default) passes through unchanged.
  const limArg = parseInt(opt("limit", String(kernel.DEFAULT_LIMIT)), 10);
  const limit = limArg === 0 ? Infinity : limArg;
  // Rank the FULL set and slice the page in the envelope (shapeQueueEnvelope),
  // exactly as the server does, so the aggregates cover every queued item and
  // this local read emits GET /v1/queue's canonical envelope
  // (task-spor-local-remote-single-renderer-conformance).
  const r = rankQueue(g, {
    project,
    assignee: opt("assignee", null),
    includeTypes: multi("type"),
    excludeTypes: multi("exclude-type"),
    readiness: multi("readiness"),
    limit: Infinity,
    front,
    frontDays: days,
    viewer,
    timestamps: g.timestamps,
  });
  // Fail loud on a zero-match --project (issue-spor-next-project-token-not-
  // roundtrippable), with the SAME text the server returns as `project_warning`
  // (graphLib.unknownProjectWarning); still exit 0 (fail-open).
  const warning = graphLib.unknownProjectWarning(g, project, "queue");
  if (warning) console.error(warning);
  const envelope = kernel.shapeQueueEnvelope(r, { limit });
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
  } else {
    console.log(renderReport(envelope));
  }
}
