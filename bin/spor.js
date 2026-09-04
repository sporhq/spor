#!/usr/bin/env node
"use strict";
// spor — the unified client CLI (dec-cc-spor-cli-universal-surface,
// task-cc-spor-cli-bin-build). The shell/human and local-mode surface that
// consolidates the scattered `node lib/*.js` entrypoints behind one verb, and
// the remote-mode surface over lib/remote.js. Mode resolves through the
// lib/config cascade (dec-spor-client-config-cascade).
//
// Two classes of verb:
//   - LOCAL graph verbs (compile/validate/queue) are byte-identical passthrough
//     to the existing lib scripts — same args, same stdout/stderr/exit — so the
//     norm-cc-byte-identical-refactor bar is met by construction.
//   - mode-aware + onboarding verbs (status/init/next/get/whoami) add the UX
//     surface the onboarding research found missing
//     (art-cc-onboarding-ux-tier-research-2026-06-14).
//
// Fail-soft: a verb that can't reach the server degrades with a clear line, it
// never dumps a stack trace at the user.

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { parseArgs } = require("util");

const ROOT = path.resolve(__dirname, "..");
const { loadConfig, DEFAULT_SERVER } = require(path.join(ROOT, "lib", "config.js"));
const remote = require(path.join(ROOT, "lib", "remote.js"));
const auth = require(path.join(ROOT, "lib", "auth.js"));
const u = require(path.join(ROOT, "scripts", "engines", "util.js"));
const { gitSpawn } = require(path.join(ROOT, "lib", "shell", "git-exec.js"));
const dispatchRuns = require(path.join(ROOT, "lib", "shell", "agent-dispatch-runner.js"));
const dispatchTerminal = require(path.join(ROOT, "lib", "shell", "dispatch-terminal.js"));
const dispatchHarnesses = require(path.join(ROOT, "lib", "shell", "dispatch-harnesses.js"));
const sat = require(path.join(ROOT, "lib", "kernel", "satisfiability.js"));
const workLoop = require(path.join(ROOT, "lib", "shell", "work-loop.js"));
const gatesKernel = require(path.join(ROOT, "lib", "kernel", "gates.js"));
const gateRunner = require(path.join(ROOT, "lib", "shell", "gate-runner.js"));
const integrationRunner = require(path.join(ROOT, "lib", "shell", "integration-runner.js"));
const workerContractLib = require(path.join(ROOT, "lib", "shell", "worker-contract.js"));
const { workerContract } = workerContractLib;
// Resolution truth (lib/kernel/resolution.js): a node is "done" when it carries a
// TERMINAL status OR a live inbound resolves/answers edge — the same partition the
// queue ranker and read surfaces use. The dispatch guard reads it so it never
// launches an agent at already-finished work (issue-spor-dispatch-resolved-task-no-guard).
const { isTerminalStatus, resolutionOf } = require(path.join(ROOT, "lib", "kernel", "resolution.js"));
// Agent-readiness (dec-spor-agent-readiness-derived-classification): the same
// derivation rankQueue uses per queue item, reused here for ONE node so the
// dispatch guard (task-spor-dispatch-readiness-guard) shares its classification
// and reason wording with `spor next` rather than re-deriving it.
const { deriveReadiness, readinessOf } = require(path.join(ROOT, "lib", "kernel", "queue.js"));
// renderReport mirrors the analyze/renderReport façade for remote `spor
// analytics`: the server returns the machine report, the client renders it with
// the SAME renderer local mode uses, so output matches (task-spor-analytics-
// remote-cli-dispatch). Requiring the module only pulls its exports — its CLI
// block is require.main-guarded.
const analyticsLib = require(path.join(ROOT, "lib", "analytics.js"));

// The CLI surface is a single declarative table (COMMANDS, defined below): it is
// the one source of truth for dispatch, flag parsing (Node's built-in
// util.parseArgs), and help — top-level AND per-command (`spor <verb> --help`).
// Adding a verb or a flag means editing one table entry; the help can't drift
// from the parser because both read the same spec. The header/footer frame the
// generated top-level listing.
const HELP_HEADER = `spor — Spor client CLI

Usage: spor <command> [args]`;
const HELP_FOOTER = `Run 'spor <command> --help' for a command's flags and detail.
Mode is set by config/env (SPOR_SERVER ⇒ remote). See 'spor status'.`;

// A consumer that closes the pipe early (`spor next | head`) makes stdout emit
// EPIPE; exit cleanly rather than crash with a stack trace.
process.stdout.on("error", (e) => {
  if (e && e.code === "EPIPE") process.exit(0);
  throw e;
});

function out(s) {
  process.stdout.write(s + "\n");
}
// `spor work` needs a refused dispatch's REASON for its status surface, and
// the reason is exactly what the refusal already prints. Rather than teach a
// dozen guard sites to report themselves twice, the loop tees this stream for
// the duration of one cmdDispatch call (workLoopTee below). Output is
// unchanged — stderr still gets every line, in order.
let ERR_TEE = null;
function err(s) {
  if (ERR_TEE) ERR_TEE.push(s);
  process.stderr.write(s + "\n");
}

// Echo which write target a mutating verb resolved to — remote server or local
// graph home — right under its confirmation line, so a write is never
// ambiguous about where it landed (task-spor-cli-write-banner-mode-echo). The
// motivating incident: an agent verifying local put-node behavior had
// SPOR_SERVER set in its env, silently resolved remote, and wrote a junk node
// to the live team graph. This is the ONE sanctioned mode difference under
// norm-spor-cli-mode-parity — every other banner line stays identical across
// modes; only this line names the resolved target.
function writeTargetLine(cfg) {
  return cfg.mode() === "remote" ? `  -> remote ${remote.base(cfg)}` : `  -> local ${cfg.graphHome()}`;
}

// Byte-identical passthrough to a lib/*.js script: inherit stdio, same argv,
// propagate the exit code. Output is identical to invoking the script directly.
function passthrough(script, args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "lib", script), ...args], { stdio: "inherit" });
  return r.status == null ? 1 : r.status;
}

function nodeCount(nodesDir) {
  try {
    return fs.readdirSync(nodesDir).filter((f) => f.endsWith(".md")).length;
  } catch {
    return null; // dir absent
  }
}

// Ensure the graph-home git repo has a committable identity. A fresh box with no
// global git config would otherwise make the SessionEnd distiller and gardener
// auto-commits fail ("empty ident name") and leave the local person node with no
// email source (task-spor-onboard-cli-init-git-identity). The user's own identity
// (global, system, or local) is ALWAYS preferred — we only set a local fallback
// for a field git can't resolve, mirroring the spor@localhost fallback the
// migrate path uses (cmdMigrate). Idempotent and confined to the graph home.
function ensureGitIdentity(home) {
  const id = gitIdentity(home);
  if (!id.name) git(home, ["config", "user.name", "spor"]);
  if (!id.email) git(home, ["config", "user.email", "spor@localhost"]);
}

// Lay down an initial commit so future auto-commits have a HEAD to build on (a
// repo on an unborn branch is what makes the distiller's plain `git commit` fail
// even once identity is set). Idempotent: a repo that already has HEAD is left
// untouched. The add is SCOPED to the graph's own files (never `-A`) so it can't
// sweep unrelated working-tree changes into the commit, and `--allow-empty` means
// HEAD is born even when there is nothing to stage yet (a fresh home).
function ensureInitialCommit(home) {
  if (git(home, ["rev-parse", "--verify", "-q", "HEAD"]).status === 0) return;
  git(home, ["add", "nodes"]); // nodes/ always exists (ensureGraphHome made it)
  if (fs.existsSync(path.join(home, ".gitignore"))) git(home, ["add", ".gitignore"]);
  git(home, [...u.NO_GPGSIGN, "commit", "-q", "--allow-empty", "-m", "spor: initialize graph"]);
}

// Idempotently create the local graph home (nodes/, git, .gitignore, a
// committable identity, and an initial commit). Returns { home, nodesDir,
// created } and prints nothing — callers do their own UX. Shared by `spor init`
// and the `spor dispatch --backfill` onboarding path.
function ensureGraphHome(cfg) {
  const home = cfg.graphHome();
  const nodesDir = path.join(home, "nodes");
  let created = false;
  if (!fs.existsSync(nodesDir)) {
    fs.mkdirSync(nodesDir, { recursive: true });
    created = true;
  }
  // git init (idempotent) so the graph is versioned, like README's bootstrap.
  let gitReady = fs.existsSync(path.join(home, ".git"));
  if (!gitReady) {
    const r = gitSpawn(home, ["init", "-q"], { stdio: "ignore" });
    if (r.error) err("note: git not found — graph created but not version-controlled");
    else gitReady = true;
  }
  const gitignore = path.join(home, ".gitignore");
  if (!fs.existsSync(gitignore)) {
    try {
      fs.writeFileSync(gitignore, "journal/\n");
    } catch {
      /* non-fatal */
    }
  }
  // A graph that can't commit is a silent onboarding failure: on a box with no
  // usable git identity the distiller/gardener auto-commits hard-fail ("empty
  // ident name"), and elsewhere they'd land an unstable machine-derived
  // `user@host` identity. Pin a committable identity + an initial commit so a
  // freshly-onboarded ~/.spor can actually persist its nodes. SKIPPED when the
  // graph home is the code repo itself (the nested `graph:` sharing layout): there
  // the graph rides the human PR flow, so we must not rewrite the code repo's git
  // identity or inject a spor commit onto its branch (dec-spor-local-mode-sharing-
  // boundary), exactly as the distiller's commit step is.
  if (gitReady && !u.graphInsideCodeRepo(home, process.cwd())) {
    ensureGitIdentity(home);
    ensureInitialCommit(home);
  }
  return { home, nodesDir, created };
}

function cmdInit(cfg) {
  const { home, nodesDir, created } = ensureGraphHome(cfg);
  out(`${created ? "Created" : "Graph already present at"} ${home}`);
  out(`  nodes:  ${nodesDir} (${nodeCount(nodesDir) ?? 0} nodes)`);
  out(`  mode:   ${cfg.mode()}`);
  // Surface the identity the graph commits as — it seeds the local person node's
  // email and is what the distiller/gardener auto-commits use. The spor@localhost
  // fallback means git had no identity; the user can override with `git config`.
  const id = gitIdentity(home);
  if (id.name || id.email) {
    out(`  commits: ${id.name || "spor"} <${id.email || "spor@localhost"}>${id.email === "spor@localhost" ? "  (set 'git config --global user.email you@example.com' to use your own)" : ""}`);
  }
  out(created ? `\nNext: start a session here, or 'spor next' to see the queue.` : "");
  return 0;
}

// Detect the dead-mute condition for `spor status` (issue-spor-local-mode-queue-
// mute-noop): the local graph carries a `queue_mute` on at least one person node,
// but this box's git identity binds to NO matching person node, or to one that
// holds no mute — so the mutes silently do nothing for this viewer. Returns a
// one-line note, or null when there's nothing to warn about (no mutes anywhere,
// or the viewer's own mute IS active). Fail-open: any load / git failure returns
// null (status must never crash). The graph dir is the same nodesDir cmdStatus
// already resolved; the git identity is read from the dir that holds the nodes,
// matching lib/queue.js's gitFront/viewerFor wiring.
function localMuteNoOp(nodesDir) {
  try {
    if (!fs.existsSync(nodesDir)) return null;
    const graphLib = require(path.join(ROOT, "lib", "graph.js"));
    const queueLib = require(path.join(ROOT, "lib", "queue.js"));
    const g = graphLib.loadGraph(nodesDir);
    // Any person node carrying a non-empty queue_mute register?
    const muters = Object.values(g.nodes).filter(
      (n) => n.type === "person" && Array.isArray(n.queue_mute) && n.queue_mute.length);
    if (!muters.length) return null; // no mutes set anywhere — nothing to warn about
    const email = queueLib.gitIdentityEmail(path.dirname(nodesDir));
    const viewer = queueLib.viewerFor(g, email);
    // The viewer resolves to a person who actually carries a mute -> mutes are
    // live for this box; no note. (Even an all-expired register counts as wired —
    // the rot is the validator's/kernel's concern, not a binding failure.)
    if (viewer && Array.isArray(viewer.queue_mute) && viewer.queue_mute.length) return null;
    const who = email || "unset";
    return `queue_mute is set on a person node but your git identity (${who}) resolves to ${viewer ? "a person node without a queue_mute" : "no matching person node"} — mutes are inactive`;
  } catch {
    return null; // fail-open: never break status on a graph/git error
  }
}

async function cmdStatus(cfg, { values }) {
  const quiet = !!(values && values.quiet);
  const mode = cfg.mode();
  const home = cfg.graphHome();
  const nodesDir = cfg.nodesDir();
  const slug = safeSlug();
  out(`mode:     ${mode}${cfg.enabled() ? "" : "  (not enabled here — run /spor:onboard to set up, or 'spor enable' to opt in; hooks are a no-op)"}`);
  out(`repo:     ${slug}`);
  if (mode === "remote") {
    const server = remote.base(cfg);
    out(`server:   ${server}`);
    // --quiet (issue-spor-status-health-probe-latency): skip the round-trips
    // (up to a 6s health probe + a 5s identity lookup) for callers that only
    // want the locally-resolved mode/project/graph fields — e.g. skills that
    // shell out to `spor status` purely to read back the project slug.
    if (!quiet) {
      const probe = await remote.get(cfg, "/v1/status", { timeoutMs: 6000 });
      if (probe.transport) out(`health:   OFFLINE — could not reach server (${probe.error})`);
      else if (probe.status === 401 || probe.status === 403) out(`health:   AUTH FAILED (${probe.status}) — token invalid, revoked, or expired`);
      else if (!probe.ok) out(`health:   error ${probe.status}`);
      else {
        const n = probe.json && probe.json.node_count;
        out(`health:   OK${n != null ? ` (${n} nodes)` : ""}`);
      }
    }
    out(`token:    ${remote.token(cfg) ? "present" : "MISSING"}`);
    if (!quiet) {
      const who = await identity(cfg);
      out(`identity: ${who}`);
    }
  } else {
    const c = nodeCount(nodesDir);
    if (c == null) out(`graph:    ${nodesDir} (not created — run 'spor init')`);
    else out(`graph:    ${nodesDir} (${c} nodes)`);
    // Split-brain detection (issue-spor-local-mode-claude-ai-mcp-split-brain,
    // dec-spor-local-mode-split-brain-mitigation). In LOCAL mode, a co-active
    // claude.ai Spor MCP connector gives the session a SECOND write surface (the
    // remote team graph) with no signal which a capture lands in: ambient hook
    // captures go local, agent/MCP-tool captures go remote. Warn so the user can
    // pick one surface. Detection is best-effort/fail-open; only fires here.
    if (sporConnectorBound(cfg)) {
      out(``);
      out(`⚠ SPLIT-BRAIN: a claude.ai Spor MCP connector is also bound on this box.`);
      out(`  In local mode you have TWO live write surfaces — this local file graph`);
      out(`  and the remote team graph behind the connector — and captures can split`);
      out(`  across them (ambient hook captures land local; MCP-tool captures land`);
      out(`  remote). Pick one surface: set SPOR_SERVER/SPOR_TOKEN to go fully remote,`);
      out(`  or disable the claude.ai Spor connector to stay fully local.`);
    }
    // Dead-mute observability (issue-spor-local-mode-queue-mute-noop). Per-viewer
    // queue_mute is wired locally now (lib/queue.js viewerFor binds the git
    // identity to its person node), but it is still a no-op when the graph carries
    // a queue_mute somewhere yet THIS box's git identity resolves to no matching
    // person node (or a person node that holds no mute) — exactly the silent half
    // of the issue. Surface it so the condition is observable instead of mystifying.
    // Best-effort + fail-open: any load/git error skips the note (never crashes status).
    const muteNote = localMuteNoOp(nodesDir);
    if (muteNote) out(`note: ${muteNote}`);
  }
  // The Node prerequisite (issue-spor-onboarding-no-node-silent-fail-open).
  // Always surfaced so a box where the hooks silently no-op has a greppable
  // explanation; loud when the running interpreter is below the engines floor.
  out(nodeRuntimeCheck().line);
  // Claude Code loads its OWN copy of the plugin, so a bumped package can leave a
  // stale plugin running silently (issue-spor-upgrade-no-plugin-refresh). When
  // the loaded version lags this package's, point the user at 'spor upgrade'.
  const plugin = claudePluginInfo(cfg);
  if (plugin && plugin.version) {
    const pkg = version();
    const stale = plugin.version !== "unknown" && pkg && plugin.version !== pkg;
    out(`plugin:   spor@spor ${plugin.version} loaded${stale ? `  (STALE — package ${pkg} installed; run 'spor upgrade')` : ""}`);
  }
  for (const w of cfg.warnings) err(`config:   ${w}`);
  return 0;
}

// Identity echo. Tries a server /v1/me; degrades clearly if the server has no
// such route yet (the onboarding research flagged this as the missing piece
// behind silent identity-degradation).
async function identity(cfg) {
  const r = await remote.get(cfg, "/v1/me", { timeoutMs: 5000 });
  if (r.transport) return `unknown (server unreachable)`;
  if (r.status === 404) return `unknown (server has no /v1/me identity echo yet)`;
  if (r.status === 401 || r.status === 403) return `unauthenticated (token rejected)`;
  if (r.ok && r.json) {
    const p = r.json.person || r.json.id;
    const name = r.json.name || p;
    const bound = r.json.bound;
    const admin = r.json.is_admin ? "  (admin)" : "";
    if (bound && p) return `${labelledPerson(name, p)}${r.json.email ? ` <${r.json.email}>` : ""}${admin}`;
    return `⚠ token maps to no person node — routed questions and personal queue will be empty`;
  }
  return `unknown (status ${r.status})`;
}

async function cmdWhoami(cfg) {
  if (cfg.mode() !== "remote") {
    out("local mode — no server identity. Set SPOR_SERVER/SPOR_TOKEN to join a team graph.");
    return 0;
  }
  out(await identity(cfg));
  return 0;
}

async function cmdNext(cfg, args) {
  // Default queue scope (task-spor-queue-default-project-config): a
  // `queue.project` cascade key pins the default --project in BOTH modes, fixing
  // the asymmetry where remote defaulted to the cwd slug and local to global. An
  // explicit --project always wins; `pinned` only fills the gap when no flag was
  // given. Unset => byte-identical to before (remote keeps the cwd default, local
  // keeps the global default — no safeSlug() injected locally).
  const pi = args.indexOf("--project");
  const explicit = pi >= 0 && args[pi + 1] ? args[pi + 1] : null;
  const pinned = cfg.get("queue.project", null);
  // Cross-project scope (task-cc-queue-filtering-enhancements): --all-projects
  // (alias --all) widens to the whole-graph firehose by dropping the cwd/pinned
  // default scope. An explicit --project is more specific and still wins.
  const allProjects = args.includes("--all-projects") || args.includes("--all");
  // Node-type allow/deny (task-cc-queue-filtering-enhancements): repeatable +
  // comma-splittable (--type task --type issue, or --type task,issue). Forwarded
  // to the server as ?type=/?exclude_type= in remote mode; in local mode the raw
  // flags pass straight through to lib/queue.js, which speaks the same flags.
  const collectMulti = (name) => {
    const out = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === `--${name}` && args[i + 1] != null) {
        out.push(...args[i + 1].split(",").map((s) => s.trim()).filter(Boolean));
      }
    }
    return out;
  };
  const inclTypes = collectMulti("type");
  const exclTypes = collectMulti("exclude-type");

  // In-flight agent surface (task-spor-cli-in-flight-surface). `spor next --json`
  // stamps each item with an `in_flight` flag by cross-referencing the live
  // background agents (`claude agents --json`); --hide-dispatched drops the items
  // that already have one. Both are CLIENT-SIDE presentation: the server's queue
  // can't see local agents, so this is computed here over either render path. The
  // cross-reference only runs when one of the two flags asks for it, so the
  // default queue path stays byte-identical (and never shells out to claude).
  const wantJson = args.includes("--json");
  const hideDispatched = args.includes("--hide-dispatched");
  const needAgents = wantJson || hideDispatched;

  if (cfg.mode() === "remote") {
    // --all-projects drops the default scope (firehose); an explicit --project
    // still wins over it. Otherwise fall back to the pinned default, then cwd.
    const scopeSlug = allProjects && !explicit ? null : (explicit ?? pinned ?? safeSlug());
    // Where the scope CAME FROM decides how a zero-match read is handled below
    // (issue-spor-next-silent-empty-on-unknown-inferred-project): an explicit
    // --project or a pinned queue.project is an INSTRUCTION — honour it and warn
    // — while the cwd slug is only this repo's best GUESS at what the user meant.
    const inferred = !!scopeSlug && !explicit && !pinned;
    const queueQs = (slug) => {
      const qs = new URLSearchParams();
      if (slug) qs.set("project", slug);
      if (inclTypes.length) qs.set("type", inclTypes.join(","));
      if (exclTypes.length) qs.set("exclude_type", exclTypes.join(","));
      return qs;
    };
    // Page size (task-spor-next-limit-flag): --limit N defaults to DEFAULT_LIMIT
    // (20), --limit 0 means "all". fetchQueuePaged sets ?limit (+?offset) per page
    // and walks next_offset to assemble the target, so the limit is never set on
    // qs here.
    const target = queueLimitTarget(args);
    let r = await fetchQueuePaged(cfg, queueQs(scopeSlug), target);
    if (r.transport) {
      err(`offline — could not reach server (${r.error})`);
      return 1;
    }
    if (!r.ok) {
      err(`queue error ${r.status}`);
      return 1;
    }
    // Zero-match handling. Unknown-token detection is authoritative only where
    // the graph is held: locally that is projectKnown(), remotely it is the
    // server, which echoes a zero-match scope token back as the additive
    // `project_warning` string (task-spor-remote-next-print-project-warning, the
    // remote twin of queue.js's projectKnown() check). Print that verbatim on
    // stderr and strip it from the envelope, so --json matches local
    // byte-for-byte — the analytics arm's pattern (analyticsRemote). Without it
    // (an older server) all we can observe is an empty result, so the notes
    // below are the best-effort fallbacks
    // (issue-spor-next-project-token-not-roundtrippable). Only an explicit
    // --all-projects — a firehose the user asked for — is never flagged.
    let projectWarning = takeProjectWarning(r.json);
    // An INFERRED scope the server authoritatively doesn't recognise is a wrong
    // guess, not an empty backlog: drop it and re-read unscoped. That re-read is
    // EXACTLY the read local mode already makes from the same directory (cmdNext
    // never injects safeSlug() there), so once it succeeds the two modes are
    // answering the same question — and a stderr note here would be a line
    // remote prints and local does not, which is the divergence
    // norm-spor-cli-mode-parity forbids. So the successful fallback is SILENT,
    // and the server's warning about the guess we just discarded is dropped with
    // it (a warning about a scope that no longer applies to the result is worse
    // than none). Gated on the server's own verdict, NEVER on a bare empty
    // result, so a KNOWN project that happens to be empty keeps its scope. A
    // re-read that itself fails leaves the first read — and its verbatim warning
    // — standing, which is the pre-existing explicit-scope behaviour.
    let fellBack = false;
    if (projectWarning && inferred) {
      const wide = await fetchQueuePaged(cfg, queueQs(null), target);
      if (!wide.transport && wide.ok) {
        r = wide;
        projectWarning = takeProjectWarning(r.json);
        fellBack = true;
      }
    }
    if (projectWarning) err(projectWarning);
    const scoped = (allProjects && !explicit) ? null : (explicit ?? pinned);
    const count = (r.json && (r.json.count ?? (Array.isArray(r.json.items) ? r.json.items.length : null)));
    if (scoped && count === 0 && !projectWarning) {
      err(`project '${scoped}' returned an empty queue — check the slug / grouping id (the server scoped to it and found nothing)`);
    } else if (inferred && !fellBack && count === 0) {
      // The reads the fallback above cannot reach: a server too old to send
      // `project_warning`, and a scope that IS known but is legitimately empty.
      // Unlike the fallback, remote here really did read something NARROWER than
      // local would have (remote defaults to the cwd slug, local to the global
      // queue), so this note does not create a mode divergence — it discloses
      // one that already exists, and staying quiet about it is the reported bug:
      // a bare "queue empty" reads as "the whole backlog is empty".
      err(`no queue items for project '${scopeSlug}' (inferred from the current directory) — run 'spor next --all-projects' for the whole graph`);
    }
    if (needAgents) {
      const q = r.json || {};
      const { items, hidden } = annotateInFlight(q.items || [], dispatchedAgents(cfg), hideDispatched);
      q.items = items;
      if (typeof q.count === "number") q.count = Math.max(0, q.count - hidden);
      // --hide-dispatched shrinks .items below whatever fetchQueuePaged assembled,
      // so returned_count (task-spor-next-pagination-metadata-coherence) must
      // shrink with it too or it stops matching q.items.length in the final
      // payload actually handed to the caller.
      if (typeof q.returned_count === "number") q.returned_count = Math.max(0, q.returned_count - hidden);
      if (hideDispatched) q.hidden_dispatched = hidden;
      if (wantJson) {
        out(JSON.stringify(q));
        return 0;
      }
      renderQueue(q, hidden);
      return 0;
    }
    if (wantJson) {
      out(JSON.stringify(r.json));
      return 0;
    }
    renderQueue(r.json);
    return 0;
  }
  // local: byte-identical passthrough. When no --project was given but a default
  // is pinned, inject it so the local read inherits the same default scope as
  // remote — UNLESS --all-projects asked for the firehose. Otherwise pass args
  // untouched (preserving the local->global default — we never inject safeSlug()
  // locally). --type/--exclude-type ride through; lib/queue.js parses them.
  const localArgs = (!explicit && pinned && !allProjects) ? [...args, "--project", pinned] : args;
  // Default path: byte-identical passthrough (no agent cross-reference). Only the
  // --json / --hide-dispatched view captures queue.js's result to annotate it.
  if (!needAgents) return passthrough("queue.js", localArgs);
  return nextLocalInFlight(cfg, localArgs, { wantJson, hideDispatched });
}

// Local in-flight surface (task-spor-cli-in-flight-surface). The default local
// `next` is a byte-identical passthrough to lib/queue.js; when --json or
// --hide-dispatched asks for the agent-aware view we run queue.js with --json,
// capture its ranked result, cross-reference dispatchedAgents(), and re-emit.
// queue.js's stderr (e.g. the unknown-project note) is inherited so it still
// surfaces; an unparseable stdout falls back to forwarding it verbatim, so an
// error path is never swallowed. The flags are presentation-only — strip them
// before handing argv to queue.js (which doesn't know them) and force --json.
function nextLocalInFlight(cfg, localArgs, { wantJson, hideDispatched }) {
  const passArgs = localArgs.filter((a) => a !== "--json" && a !== "--hide-dispatched");
  passArgs.push("--json");
  const r = spawnSync(process.execPath, [path.join(ROOT, "lib", "queue.js"), ...passArgs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const status = r.status == null ? 1 : r.status;
  let q;
  try {
    q = JSON.parse(r.stdout);
  } catch {
    if (r.stdout) process.stdout.write(r.stdout); // forward queue.js's own output
    return status;
  }
  const { items, hidden } = annotateInFlight(q.items || [], dispatchedAgents(cfg), hideDispatched);
  q.items = items;
  if (typeof q.count === "number") q.count = Math.max(0, q.count - hidden);
  if (hideDispatched) q.hidden_dispatched = hidden;
  if (wantJson) {
    out(JSON.stringify(q, null, 2)); // match queue.js --json (pretty, 2-space)
    return status;
  }
  renderQueueLocalText(q, hidden);
  return status;
}

// Mirror lib/queue.js's HUMAN render for the local --hide-dispatched text path
// (the --json path re-emits queue.js's own object, so only this form is
// reconstructed). Kept byte-identical to queue.js by a conformance test — if
// queue.js's line format moves, that test fails and both must move together
// (norm-cc-byte-identical-refactor). count was already decremented by `hidden`,
// so the "(N more — raise --limit)" overflow math is unaffected by hiding.
function renderQueueLocalText(q, hidden = 0) {
  const items = (q && q.items) || [];
  if (!items.length) out("queue empty — nothing queueable and live");
  for (const [i, it] of items.entries()) {
    out(`${i + 1}. [${it.score}] ${it.id} — ${it.title} (${it.type}${it.status ? `, ${it.status}` : ""}${it.suggest === "close" ? ", suggest: close" : ""})`);
    out(`   ${it.why}`);
  }
  if (q.count > items.length) out(`(${q.count - items.length} more — raise --limit)`);
  if (q.muted > 0) out(`(${q.muted} muted — your queue_mute)`);
  if (q.blocked > 0) out(`(${q.blocked} blocked — gated by live work, hidden until unblocked)`);
  if (hidden > 0) out(`(${hidden} in-flight hidden — --hide-dispatched)`);
}

// Enumerate one cli-json harness's background agents: {ok, agents}. `ok` answers
// "could I ask at all?" — a binary that's absent, exits nonzero, or prints
// garbage says NOTHING about liveness, and run reconciliation
// (inc-spor-dispatch-session-vanished-2026-07-18) must not read that silence as
// "every run is dead". SPOR_FAKE_AGENTS_JSON is the same test seam as before.
function enumerateHarnessAgents(adapter, cfg = null) {
  const discovery = adapter.activeDiscovery || {};
  if (discovery.kind !== "cli-json") return { ok: false, agents: [] };
  let text = process.env.SPOR_FAKE_AGENTS_JSON;
  if (text == null) {
    // Resolve through the cascade like the dispatch launcher does, so a box
    // whose launcher lives at `dispatch.bin.<harness>` rather than on PATH is
    // still enumerable — otherwise the in-flight surface would go permanently
    // blank on exactly the machines that key exists to serve
    // (task-spor-dispatch-adapters-opencode-copilot).
    const cmd = adapter.command(process.env, cfg);
    if (cmd === "claude" && !hasCmd(cmd)) return { ok: false, agents: [] };
    const r = spawnPortableSync(cmd, discovery.args, { encoding: "utf8", timeout: 5000 });
    if (r.status !== 0 || !r.stdout) return { ok: false, agents: [] };
    text = r.stdout;
  }
  let arr;
  try { arr = JSON.parse(text); } catch { return { ok: false, agents: [] }; }
  if (!Array.isArray(arr)) return { ok: false, agents: [] };
  return { ok: true, agents: arr };
}

// The live-agent listing is the NATIVE path's evidence and nobody else's: a
// `native-background` record — a `spor dispatch --bg` opt-in, or one written
// before the supervised default (task-spor-claude-adapter-headless-supervised)
// — is reconciled against `claude agents --json`, while a supervised run is
// reconciled against its own supervisor process and never reads the listing.
// So the listing is only worth taking (a CLI boot per cli-json harness, on
// every `spor runs` and every work-loop poll) when some record still needs it:
// a NON-TERMINAL native one among `records`. Otherwise nothing is listed and
// `enumerated: false` is the honest answer — reconcileRuns consults it only
// for the native records there are none of, so the outcome is identical to a
// successful empty listing at zero cost (task-spor-retire-native-bg-
// enumerated-skip-after-supervised-default). A worker's own dispatches are all
// supervised (cmdDispatch's `supervisedOnly`), so a worker following only its
// own runs never spawns a harness here at all.
function nativeAgentEvidence(cfg, records) {
  const needed = (records || []).some(
    (r) => r && r.launch_mode === "native-background" && !dispatchRuns.TERMINAL_STATES.has(r.state)
  );
  if (!needed) return { agents: [], enumerated: false };
  let enumerated = false;
  const agents = [];
  for (const adapter of dispatchHarnesses.discoveryAdapters({ cfg })) {
    if ((adapter.activeDiscovery || {}).kind !== "cli-json") continue;
    const e = enumerateHarnessAgents(adapter, cfg);
    if (!e.ok) continue;
    enumerated = true;
    // A finished agent the harness still lists is NOT live — reconciling it is
    // the whole point, so it must not hold its run open (same `done` filter the
    // in-flight surface applies).
    for (const a of e.agents) if (a && a.kind === "background" && a.state !== "done") agents.push(a);
  }
  return { agents, enumerated };
}

// Active background agents keyed by node id (task-spor-cli-in-flight-surface).
// `spor dispatch` names each background agent after the node id it works
// (cmdDispatch: name = name || nodeId), so `claude agents --json` lets the queue
// CLI mark which items already have an agent in flight — a NO-LLM, parseable
// cross-reference that needs no model guidance. Returns Map<node-id, agent[]> of
// the BACKGROUND agents still active (state !== "done"), each summarized to
// {id, name, state, status, cwd}. FAIL-SOFT by contract (the feature is a pure
// enhancement): the claude binary absent / a nonzero exit / a timeout /
// unparseable output all yield an EMPTY map, never an error — so `spor next
// --json` still works in Cowork and plain-shell contexts where claude is absent
// (every item then reads in_flight:false). SPOR_FAKE_AGENTS_JSON injects canned
// output for tests, mirroring SPOR_FAKE_MCP_LIST; all claude shell-outs route
// through claudeCmd() so an SPOR_CLAUDE_CMD stub works too.
function dispatchedAgents(cfg) {
  try {
    const map = new Map();
    const add = (name, summary) => {
      const list = map.get(name) || [];
      list.push(summary);
      map.set(name, list);
    };
    const home = cfg && typeof cfg.userConfigHome === "function" ? cfg.userConfigHome() : u.userConfigHome();
    // discoveryAdapters, not harnesses: a `--bg` claude-code run (and every
    // native record from before the supervised default) is enumerated through
    // the adapter's native variant, while its supervised runs come off run records.
    for (const adapter of dispatchHarnesses.discoveryAdapters({ cfg })) {
      const discovery = adapter.activeDiscovery || {};
      if (discovery.kind === "run-records") {
        for (const a of dispatchRuns.activeRuns(home)) {
          if (a && a.harness === adapter.id && typeof a.name === "string") add(a.name, a);
        }
        continue;
      }
      if (discovery.kind !== "cli-json") continue;
      const { ok, agents: arr } = enumerateHarnessAgents(adapter, cfg);
      if (!ok) continue;
      for (const a of arr) {
        if (!a || a.kind !== "background" || typeof a.name !== "string") continue;
        if (a.state === "done") continue;
        add(a.name, {
          id: a.id, name: a.name, harness: adapter.id, state: a.state,
          status: a.status, cwd: a.cwd, sessionId: a.sessionId, startedAt: a.startedAt,
        });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The candidate agents `spor dispatch` could have just launched in `dir`
// (dec-spor-dispatch-bg-session-late-bind), newest first. `claude --bg`
// self-allocates and prints only a SHORT id, but `claude agents --json`
// reports the full `sessionId` + `cwd` + `startedAt` — the reliable capture
// path. Match on cwd (the strong signal — we just launched there), then on
// name when given.
//
// A launch name is derived from the node id (or truncated task text), so it
// is REUSED by every re-dispatch of that node into the same dir — it is not
// unique across runs (issue-spor-dispatch-unbound-run-identity-not-unique). A
// stale agent from an EARLIER dispatch of the same node can still be listed
// (a slow-to-finish or zombie entry) and would otherwise look like a valid
// candidate the moment this poll starts, before our own agent has even
// registered. `since` (this launch's own record.created_at) filters those
// out: nothing that started before we launched can be the run we just
// started, so only a genuinely NEW agent counts as a candidate.
function dispatchedSessionCandidates(cfg, name, dir, since = 0) {
  const all = [];
  for (const arr of dispatchedAgents(cfg).values()) {
    for (const a of arr) if (!a.harness || a.harness === "claude-code") all.push(a);
  }
  let cands = all.filter((a) => a.sessionId && (!dir || a.cwd === dir));
  // A launch name is an exact identity, so REQUIRE it rather than preferring it.
  // Several dispatches share one checkout (every `--no-worktree` dispatch into
  // the same repo does), so "newest in this directory" can be a sibling's
  // session — and during the poll window our own agent is often not registered
  // yet while a sibling already is, which is exactly when the fallback fires and
  // stamps the run with someone else's session
  // (issue-spor-dispatch-run-liveness-same-cwd-misattribution). An empty result
  // just keeps polling until ours appears; an honest miss beats a wrong id.
  if (name) cands = cands.filter((a) => a.name === name);
  if (since) cands = cands.filter((a) => (Number(a.startedAt) || 0) >= since);
  cands.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return cands;
}

// Capture the launched run's session, polling briefly while the daemon registers
// it. Returns the sessionId or null (fail-open — the caller degrades to session-null).
//
// `since` bounds candidates to this launch (see dispatchedSessionCandidates).
//
// `pinned` (SPOR_SESSION_ID) exists for tests/reproducibility and used to
// short-circuit the poll unconditionally — but an ambient env var is not proof
// it names THIS launch's session; left exported in a real shell it would
// otherwise stamp a dispatched run with the CALLER's own session and transcript
// (issue-spor-dispatch-ambient-session-id-borrows-caller-transcript). So the pin
// is now verified INSIDE the same poll used for ordinary discovery, not checked
// once up front: registration lags the launch by an uncertain amount (the whole
// reason the poll loop exists), so a single pre-loop check would see an empty
// candidate set on every real dispatch and rubber-stamp the pin before the real,
// contradicting session had a chance to register. Each iteration: candidates
// found and the pin is among them => confirmed, return it; candidates found and
// the pin is NOT among them => proven wrong, drop it and return the newest
// discovered session instead (never the pin); no candidates yet => keep
// waiting. If the whole poll never finds any candidate, discovery had nothing
// to contradict the pin with, so it falls back to trusting it (the fast path
// tests rely on, where no agent is ever faked into existence).
async function captureDispatchSession(cfg, name, dir, pinned, since = 0) {
  for (let i = 0; i < 6; i++) {
    const cands = dispatchedSessionCandidates(cfg, name, dir, since);
    if (cands.length) {
      if (!pinned) return cands[0].sessionId;
      if (cands.some((a) => a.sessionId === pinned)) return pinned;
      err(`warning: SPOR_SESSION_ID (${pinned}) does not match the launched agent's session — ignoring the pin.`);
      return cands[0].sessionId;
    }
    await sleep(300);
  }
  return pinned || null;
}

// Stamp items[].in_flight from the dispatched-agent map, optionally dropping the
// in-flight ones (--hide-dispatched). Every kept item gets an in_flight boolean
// (so the flag is present on all of them — claude absent => uniformly false);
// an in-flight item also carries a `dispatched` array of agent summaries.
// Returns the kept items and the count of hidden ones.
function annotateInFlight(items, agentMap, hide) {
  const kept = [];
  let hidden = 0;
  for (const it of items || []) {
    const agents = (it && it.id && agentMap.get(it.id)) || null;
    const inFlight = !!(agents && agents.length);
    if (inFlight && hide) {
      hidden++;
      continue;
    }
    if (it && typeof it === "object") {
      it.in_flight = inFlight;
      if (inFlight) it.dispatched = agents;
    }
    kept.push(it);
  }
  return { items: kept, hidden };
}

function renderQueue(q, hidden = 0) {
  const items = (q && q.items) || [];
  if (!items.length) {
    out("queue empty — nothing queueable and live");
  } else {
    for (const it of items) {
      out(`${(it.score ?? 0).toFixed ? it.score.toFixed(2) : it.score}  ${it.suggest || "do"}  ${it.id}`);
      if (it.why) out(`        ${it.why}`);
    }
  }
  // Overflow hint (task-spor-next-limit-flag): when the page shows fewer than the
  // full ranked total, say how many more and how to get them — the remote mirror
  // of lib/queue.js's "(N more — raise --limit)". count is the full-set total
  // (the server ranks the whole set and slices only the page); with --limit 0
  // every item is fetched, so count == items.length and this stays silent.
  if (q && typeof q.count === "number" && q.count > items.length) {
    out(`(${q.count - items.length} more — raise --limit, or --limit 0 for all)`);
  }
  // Counted, not silent: blocked items are gated out of the actionable queue
  // (dec-spor-queue-hide-blocked), reported so their disappearance is never
  // silent. Present only when the server forwards r.blocked; absent => no line.
  if (q && q.blocked > 0) out(`(${q.blocked} blocked — gated by live work, hidden until unblocked)`);
  // Never-silent truncation (task-spor-cli-in-flight-surface): report what
  // --hide-dispatched removed, the way queue.js surfaces the muted count.
  if (hidden > 0) out(`(${hidden} in-flight hidden — --hide-dispatched)`);
}

// --limit parse for `spor next` (task-spor-next-limit-flag). Default is
// DEFAULT_LIMIT (20 — the same kernel default local mode uses, keeping the two
// modes symmetric); --limit 0 means "all" (-> Infinity). A non-numeric or
// negative value falls back to the default rather than rendering an empty or
// runaway page. Local mode never calls this — it passes --limit straight through
// to lib/queue.js, which does the identical 0 -> all translation.
function queueLimitTarget(args) {
  const { DEFAULT_LIMIT } = require(path.join(ROOT, "lib", "queue.js"));
  const i = args.indexOf("--limit");
  if (i < 0 || args[i + 1] == null) return DEFAULT_LIMIT;
  const n = parseInt(args[i + 1], 10);
  if (n === 0) return Infinity;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
}

// Lift the server's additive `project_warning` off a GET /v1/queue envelope
// (task-spor-remote-next-print-project-warning): a non-empty string when the
// `project` token matched no repo, grouping, or project stamp — the
// /v1/analytics shape. Returns it (or null) and DELETES it from the envelope so
// what the caller prints/keeps carries only the fields local mode has.
function takeProjectWarning(envelope) {
  if (!envelope || typeof envelope !== "object") return null;
  const w = envelope.project_warning;
  if (w !== undefined) delete envelope.project_warning;
  return typeof w === "string" && w ? w : null;
}

// Page through GET /v1/queue assembling up to `target` items (Infinity = all)
// (task-spor-next-limit-flag). The server caps each page at 100 (API.md §5) and
// reads limit 0 as its own default, so "all" — and any finite N>100 — must be
// assembled client-side: request pages of <=100 over `offset`, following
// `next_offset` until we have `target` items or the pages run out. The full-set
// aggregates (count, counts_by_*, questions/findings/…) are identical on every
// page (the server ranks the whole set and slices only the page), so we keep the
// FIRST page's envelope for those. But `returned_count`/`truncated`/`next_offset`
// describe a SINGLE page, not the assembled result — those come from the LAST
// page actually fetched and from the final item count instead
// (task-spor-next-pagination-metadata-coherence), so a caller assembling all 105
// items of a 105-item queue sees returned_count:105/truncated:false rather than
// the first page's stale returned_count:100/truncated:true. A finite limit <=100
// is a single request — byte-compatible with the old hardcoded read. Returns the
// failing remote.get result verbatim on transport/HTTP error so the caller's
// existing checks fire.
async function fetchQueuePaged(cfg, baseQs, target) {
  const items = [];
  let envelope = null;
  let lastPage = null;
  let offset = 0;
  while (items.length < target) {
    const want = target === Infinity ? 100 : Math.min(100, target - items.length);
    const qs = new URLSearchParams(baseQs);
    qs.set("limit", String(want));
    qs.set("offset", String(offset));
    const r = await remote.get(cfg, `/v1/queue?${qs.toString()}`, { timeoutMs: 6000 });
    if (r.transport || !r.ok) return r;
    const page = r.json || {};
    if (!envelope) envelope = page;
    lastPage = page;
    const pageItems = Array.isArray(page.items) ? page.items : [];
    items.push(...pageItems);
    const next = page.next_offset;
    if (next == null || pageItems.length === 0 || next <= offset) break;
    offset = next;
  }
  envelope = envelope || { items: [], count: 0 };
  // `want` above never asks for more than the remaining budget to `target`, so
  // `items.length` can never exceed a finite target, and `finalItems === items`
  // by reference when target is Infinity — finalItems.length always equals
  // items.length here, never less.
  const finalItems = target === Infinity ? items : items.slice(0, target);
  envelope.items = finalItems;
  envelope.returned_count = finalItems.length;
  if (lastPage) {
    // Whether more remains beyond the assembled result is exactly what the
    // last page fetched said about what comes after IT.
    envelope.truncated = !!lastPage.truncated;
    envelope.next_offset = lastPage.truncated ? lastPage.next_offset : null;
  }
  return { ok: true, json: envelope };
}

async function cmdGet(cfg, { positionals, values }) {
  const id = positionals[0];
  if (!id) {
    err("usage: spor get <id> [--json]");
    return 1;
  }
  if (cfg.mode() === "remote") {
    const r = await remote.get(cfg, `/v1/nodes/${encodeURIComponent(id)}`, { timeoutMs: 6000 });
    if (r.transport) {
      err(`offline — could not reach server (${r.error})`);
      return 1;
    }
    if (r.status === 404) {
      err(`no such node: ${id}`);
      return 1;
    }
    if (!r.ok) {
      err(`error ${r.status}`);
      return 1;
    }
    if (!values.json) {
      out(r.json && r.json.raw ? r.json.raw : r.text);
      return 0;
    }
    // --json: parse the raw with the SAME lib parser as local (parity), take the
    // server's git-blob-sha revision, and gather inbound edges from the team graph
    // (the documented graph-wide sweep via GET /v1/export — there is no inbound
    // endpoint, the same path `spor query --to` walks).
    const graphLib = require(path.join(ROOT, "lib", "graph.js"));
    const raw = r.json && r.json.raw;
    if (typeof raw !== "string") {
      err(`error: server returned no node body for ${id}`);
      return 1;
    }
    const node = graphLib.parseFrontmatter(raw, `${id}.md`);
    const fetched = await fetchRemoteExportNodes(cfg, "get");
    if (fetched.error) return 1; // already reported
    let inbound;
    try {
      inbound = inboundEdges(graphLib.loadGraph(fetched.nodesDir), node.id);
    } finally {
      fetched.cleanup();
    }
    out(JSON.stringify(getNodeJson(node, inbound, r.json.revision), null, 2));
    return 0;
  }
  // local: read the node file
  const nodesDir = cfg.nodesDir();
  const f = path.join(nodesDir, `${id}.md`);
  if (!values.json) {
    try {
      out(fs.readFileSync(f, "utf8"));
      return 0;
    } catch {
      err(`no such node: ${id}`);
      return 1;
    }
  }
  // --json: parse the file, scan the loaded graph for inbound edges, and stamp the
  // git blob SHA as `revision` — recomputed zero-dep (crypto builtin), byte-
  // identical to the server's value for the same content (norm-spor-cli-mode-parity).
  let raw;
  try {
    raw = fs.readFileSync(f);
  } catch {
    err(`no such node: ${id}`);
    return 1;
  }
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  const node = graphLib.parseFrontmatter(raw.toString("utf8"), `${id}.md`);
  const inbound = inboundEdges(graphLib.loadGraph(nodesDir), node.id);
  out(JSON.stringify(getNodeJson(node, inbound, gitBlobSha(raw)), null, 2));
  return 0;
}

// The `spor get --json` shape (issue-spor-cli-get-missing-json-flag): one
// structured object so scripts stop scraping frontmatter. Built from a node
// parsed by the SAME lib/graph parser in both modes (norm-spor-cli-mode-parity).
// Frontmatter = lib/query.js's shared cleanNode projection (drop the load-time
// `file` artifact + the parser's empty pin/exclude registers) minus what we
// surface separately (edges, body); the synthesized `project` (from repo:) is
// kept — every consumer keys on it and the server's frontmatter carries it too.
function getNodeJson(node, inbound, revision) {
  const { cleanNode } = require(path.join(ROOT, "lib", "query.js"));
  const frontmatter = cleanNode(node);
  delete frontmatter.edges;
  delete frontmatter.body;
  return {
    id: node.id,
    frontmatter,
    body: node.body || "",
    edges: { outbound: node.edges || [], inbound: inbound || [] },
    revision: revision ?? null,
  };
}

// Inbound edges to a node from a loaded graph — every other node's out-edge that
// points here, as {from, type}. Reuses lib/query.js's --to walk (a node only
// stores its own out-edges, so inbound is a whole-graph scan).
function inboundEdges(graph, id) {
  const { queryGraph } = require(path.join(ROOT, "lib", "query.js"));
  return queryGraph(graph, { edges: true, to: id }).edges.map((e) => ({ from: e.from, type: e.type }));
}

// The git blob SHA of a node's bytes — the value the server stores as `revision`
// (API.md §0) and an update sends back. Pure Node (crypto builtin, zero-dep):
// sha1 of "blob <len>\0<bytes>", exactly `git hash-object`, so a local --json
// revision is byte-identical to the server's for the same content (verified
// against the live graph).
function gitBlobSha(buf) {
  const h = require("crypto").createHash("sha1");
  h.update(`blob ${buf.length}\0`);
  h.update(buf);
  return h.digest("hex");
}

// --- spor put-node: full validated node writes -----------------------------
// The shell twin of MCP put_node / REST POST /v1/nodes: write a complete node
// markdown file (frontmatter + body) through the same create/update collision
// policy instead of dropping to raw REST from scripts and skills.
function readPutNodeInput(input) {
  if (!input || input === "-") {
    try {
      return { raw: fs.readFileSync(0, "utf8"), label: "stdin" };
    } catch (e) {
      return { error: `could not read stdin: ${e.message}` };
    }
  }
  try {
    return { raw: fs.readFileSync(input, "utf8"), label: input };
  } catch (e) {
    return { error: `could not read ${input}: ${e.message}` };
  }
}

function parsePutNode(raw, label) {
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  let first;
  try {
    first = graphLib.parseFrontmatter(raw, label || "incoming.md");
  } catch (e) {
    return { error: `invalid node: ${e.message}` };
  }
  if (!first.id) return { error: "invalid node: missing id" };
  if (!NODE_ID_RE.test(first.id)) return { error: `bad node id '${first.id}' — expected kebab-case` };
  try {
    return { node: graphLib.parseFrontmatter(raw, `${first.id}.md`) };
  } catch (e) {
    return { error: `invalid node: ${e.message}` };
  }
}

function normalizeIfExists(raw) {
  const value = raw == null ? "error" : String(raw).trim().toLowerCase();
  if (["error", "skip", "update"].includes(value)) return { ok: true, value };
  return { ok: false, error: `--if-exists must be one of: error, skip, update` };
}

function renderPutNodeResult(cfg, res, json) {
  if (json) {
    out(JSON.stringify(res || {}, null, 2));
    return;
  }
  const status = (res && res.status) || "ok";
  const id = res && res.id ? res.id : "(unknown)";
  const rev = res && res.revision ? ` @ ${res.revision}` : "";
  out(status === "skipped" ? `put-node skipped: ${id}${rev}` : `put-node ${status}: ${id}${rev}`);
  out(writeTargetLine(cfg));
  for (const w of (res && res.warnings) || []) err(`  warning: ${w}`);
}

function putNodeEntryError(res0, httpStatus, prefix = "put-node") {
  const parts = [];
  if (res0 && res0.message) parts.push(res0.message);
  if (res0 && res0.code && !parts.includes(res0.code)) parts.push(res0.code);
  if (res0 && Array.isArray(res0.details)) parts.push(...res0.details);
  if (res0 && res0.revision) parts.push(`current revision: ${res0.revision}`);
  return `${prefix} error ${httpStatus}${parts.length ? `: ${parts.join("; ")}` : ""}`;
}

function copyNodeFilesForValidation(srcNodes, dstNodes, targetId, raw) {
  fs.mkdirSync(dstNodes, { recursive: true });
  for (const ent of fs.readdirSync(srcNodes, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    if (ent.name === `${targetId}.md`) continue;
    fs.copyFileSync(path.join(srcNodes, ent.name), path.join(dstNodes, ent.name));
  }
  fs.writeFileSync(path.join(dstNodes, `${targetId}.md`), raw);
}

function validatePutNodeLocal(nodesDir, node, raw) {
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  let g;
  try {
    g = graphLib.loadGraph(nodesDir);
  } catch (e) {
    return { error: `could not load graph: ${e.message}` };
  }
  const v = graphLib.validateNode(g, node);
  if (!v.ok) return { error: `invalid node:\n  ${v.errors.join("\n  ")}` };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spor-put-node-"));
  const tmpNodes = path.join(tmp, "nodes");
  try {
    copyNodeFilesForValidation(nodesDir, tmpNodes, node.id, raw);
    const vg = graphLib.validateGraph(tmpNodes);
    // Pre-existing corruption in OTHER node files must not refuse this write
    // (dec-spor-buildgraph-per-node-fault-isolation). The loader survives a
    // malformed sibling by skipping it, so the writer has to as well — this
    // gate lints the WHOLE graph, so without the split one unrelated bad file
    // would lock the entire local graph read-only, and the "invalid graph
    // after put-node" banner would name a node this write never touched.
    // Errors on the file being WRITTEN still block (including the case where
    // the target was itself the skipped file and the new bytes are no better),
    // and the demoted ones ride along as warnings so the corruption stays
    // visible; `spor validate` is where it is an exit-1 problem.
    const carried = (g.skipped || []).map((sk) => sk.file).filter((f) => f !== `${node.id}.md`);
    const preExisting = (e) => carried.some((f) => String(e).startsWith(`${f}: `));
    const blocking = (vg.errors || []).filter((e) => !preExisting(e));
    if (blocking.length) return { error: `invalid graph after put-node:\n  ${blocking.join("\n  ")}` };
    const carriedErrors = (vg.errors || []).filter(preExisting).map((e) => `pre-existing: ${e}`);
    return { ok: true, warnings: [...(vg.warnings || []), ...carriedErrors] };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function cmdPutNode(cfg, { values, positionals }) {
  const input = positionals[0] || "-";
  const ifExists = normalizeIfExists(values["if-exists"]);
  if (!ifExists.ok) {
    err(ifExists.error);
    return 1;
  }
  const policy = ifExists.value;
  const revision = values.revision || null;
  if (policy === "update" && !revision) {
    err("put-node update requires --revision from 'spor get <id> --json'");
    return 1;
  }
  if (policy !== "update" && revision) {
    err("--revision is only valid with --if-exists update");
    return 1;
  }

  const inputRes = readPutNodeInput(input);
  if (inputRes.error) {
    err(inputRes.error);
    return 1;
  }
  const raw = inputRes.raw;
  const parsed = parsePutNode(raw, inputRes.label);
  if (parsed.error) {
    err(parsed.error);
    return 1;
  }
  const id = parsed.node.id;

  if (cfg.mode() === "remote") {
    const entry = { node: raw, if_exists: policy };
    if (revision) entry.revision = revision;
    const r = await remote.post(cfg, "/v1/nodes", { nodes: [entry] }, { timeoutMs: 15000 });
    if (r.transport) {
      err(`offline — could not reach server (${r.error})`);
      return 1;
    }
    const res0 = r.json && r.json.results && r.json.results[0];
    if (!(res0 && res0.ok)) {
      const top = r.json && r.json.error;
      if (top && !res0) err(`put-node error ${r.status}${top.message ? `: ${top.message}` : ""}`);
      else err(putNodeEntryError(res0, r.status));
      return 1;
    }
    renderPutNodeResult(cfg, res0, !!values.json);
    return 0;
  }

  const nodesDir = cfg.nodesDir();
  if (!fs.existsSync(nodesDir)) {
    err(`no graph at ${nodesDir} — run 'spor init' first`);
    return 1;
  }
  const file = path.join(nodesDir, `${id}.md`);
  const exists = fs.existsSync(file);
  if (!exists && id.length > MAX_ID_LENGTH) {
    err(`bad node id '${id}': ${id.length} chars exceeds ${MAX_ID_LENGTH} (new node ids must be at most ${MAX_ID_LENGTH} chars)`);
    return 1;
  }
  if (policy === "error" && exists) {
    err(`node already exists: ${id} (use --if-exists update with --revision, or --if-exists skip)`);
    return 1;
  }
  if (policy === "skip" && exists) {
    const res = { ok: true, status: "skipped", id, revision: gitBlobSha(fs.readFileSync(file)), warnings: [] };
    renderPutNodeResult(cfg, res, !!values.json);
    return 0;
  }
  if (policy === "update") {
    if (!exists) {
      err(`no such node: ${id}`);
      return 1;
    }
    const current = gitBlobSha(fs.readFileSync(file));
    if (current !== revision) {
      err(`put-node conflict: stale revision for ${id}; current revision: ${current}`);
      return 1;
    }
  }

  const valid = validatePutNodeLocal(nodesDir, parsed.node, raw);
  if (valid.error) {
    err(valid.error);
    return 1;
  }
  fs.writeFileSync(file, raw);
  const res = { ok: true, status: exists ? "updated" : "created", id, revision: gitBlobSha(Buffer.from(raw)), warnings: valid.warnings || [] };
  renderPutNodeResult(cfg, res, !!values.json);
  return 0;
}

// --- spor blame / commits: commit-sha -> nodes reverse lookup ---------------
// (task-spor-blame-commit-lookup-cli-verb) The shell verb over the commit->node
// reverse index: which decisions/tasks/issues reference a git commit in their
// `commits:` field — blame a line, get the why, without curl. Dual-mode like
// `get` (norm-spor-cli-mode-parity): remote dispatches to GET /v1/commits/{sha}
// (the server's store.lookupCommit); local scans the graph home with the pure
// lib/query.js twin. The reverse link was reachable over REST/MCP but had no
// shell verb (task-cc-commit-linking gave node->commit; this is commit->node).
// An empty result is VALID (exit 0) — a commit linked to no node — never an error.
async function cmdBlame(cfg, { positionals, values }) {
  const raw = positionals[0];
  if (!raw) {
    err("usage: spor blame <sha> [--repo <slug>]   (alias: spor commits <sha>)");
    return 1;
  }
  // Mirror the server's gate: lowercase, then 7-40 hex (abbreviated or full).
  const sha = String(raw).toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    err(`bad sha '${raw}' — give 7-40 hex chars (abbreviated or full).`);
    return 1;
  }
  const repo = values.repo || null;
  if (repo && !/^[a-z0-9][a-z0-9-]*$/.test(repo)) {
    err(`bad --repo '${repo}' — a kebab-case repo slug (^[a-z0-9][a-z0-9-]*$).`);
    return 1;
  }

  let matches;
  if (cfg.mode() === "remote") {
    const q = repo ? `?repo=${encodeURIComponent(repo)}` : "";
    const r = await remote.get(cfg, `/v1/commits/${encodeURIComponent(sha)}${q}`, { timeoutMs: 6000 });
    if (r.transport) {
      err(`offline — could not reach server (${r.error})`);
      return 1;
    }
    if (r.status === 422) {
      const msg = r.json && r.json.error && r.json.error.message;
      err(`invalid request${msg ? ` — ${msg}` : ""}`);
      return 1;
    }
    if (!r.ok) {
      err(`error ${r.status}`);
      return 1;
    }
    matches = r.json && Array.isArray(r.json.matches) ? r.json.matches : [];
  } else {
    // local: scan the graph home with the pure lib/query.js lookup.
    const nodesDir = cfg.nodesDir();
    if (!fs.existsSync(nodesDir)) {
      err(`no Spor graph at ${nodesDir} — run 'spor init', or set SPOR_SERVER for a team graph.`);
      return 1;
    }
    const graphLib = require(path.join(ROOT, "lib", "graph.js"));
    const { lookupCommit } = require(path.join(ROOT, "lib", "query.js"));
    matches = lookupCommit(graphLib.loadGraph(nodesDir), sha, repo);
  }

  // Stable, mode-symmetric order (node id, then stored sha) — local already
  // sorts in lookupCommit; sort the server's insertion-order matches the same
  // way so the human/JSON output is identical regardless of mode.
  matches.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));

  // Mode-symmetric JSON: the same {sha, repo?, matches} shape in both modes.
  if (values.json) {
    out(JSON.stringify({ sha, ...(repo ? { repo } : {}), matches }, null, 2));
    return 0;
  }
  if (!matches.length) {
    out(`no nodes reference commit ${sha}${repo ? ` in ${repo}` : ""}`);
    return 0;
  }
  out(`${sha} — referenced by ${matches.length} node${matches.length === 1 ? "" : "s"}:`);
  for (const m of matches) {
    const meta = [m.type, m.status].filter(Boolean).join(", ");
    out(`  ${m.id}${meta ? `  [${meta}]` : ""}`);
    const desc = m.title || m.summary;
    if (desc) out(`      ${desc}`);
    const loc = [`${m.repo}@${m.sha}`, m.project ? `project: ${m.project}` : null].filter(Boolean).join(" · ");
    out(`      ${loc}`);
  }
  return 0;
}

// --- spor history: per-node git-log lineage --------------------------------
// (task-spor-history-cli-verb) The shell front-door for a single node's commit
// history — every revision's actor, time, and what changed — as a `git log`
// projection over nodes/<id>.md. The frontmatter `author` field re-stamps to the
// LAST editor on every write, so git history is the only durable record of the
// full chain of editors; this gives it a read surface short of the whole-corpus
// `spor export` tarball. Dual-mode like `get`/`blame` (norm-spor-cli-mode-parity):
// remote dispatches to GET /v1/nodes/{id}/history (the cheap commit list) and
// GET /v1/nodes/{id}/history/{sha} (the diff sub-fetch); local runs the same
// git-log projection over the graph home via lib/history.js, the faithful twin of
// the server's computeNodeHistory / computeNodeHistoryEntry cores. Both render
// through the shared lib/history.js renderers so output matches across modes.
async function cmdHistory(cfg, { positionals, values }) {
  const id = positionals[0];
  const sha = positionals[1] || null;
  if (!id) {
    err("usage: spor history <id> [<sha>] [--limit N] [--json] [--content]");
    return 1;
  }
  const history = require(path.join(ROOT, "lib", "history.js"));
  // Mirror the server's gates so a bad id/sha fails the same way in both modes.
  if (!history.isNodeId(id)) {
    err(`bad node id '${id}' — a kebab-case slug (^[a-z0-9][a-z0-9-]*$).`);
    return 1;
  }
  if (sha && !history.isShaLike(sha)) {
    err(`bad sha '${sha}' — give 7-40 hex chars (abbreviated or full).`);
    return 1;
  }
  return sha
    ? await historyEntry(cfg, history, id, sha, values)
    : await historyList(cfg, history, id, values);
}

// The person->actor mapping for the local arm: index the local graph's person
// nodes by email (the twin of the server's in-memory personEmailIndex), so a
// history entry can point a real actor at their person node. Loading the graph is
// the accepted local cost for these git-projection verbs (blame does the same); a
// missing/unreadable graph degrades to no mapping — the actor name/email still
// renders. Returns a Map (possibly empty), never throws.
function historyEmailIndex(history, nodesDir) {
  try {
    const graphLib = require(path.join(ROOT, "lib", "graph.js"));
    return history.personEmailIndex(graphLib.loadGraph(nodesDir));
  } catch {
    return null;
  }
}

// The list arm: a node's ordered commit list (newest first). Remote dispatches
// GET /v1/nodes/{id}/history?limit=N; local runs the git-log twin. A count of 0
// (no commit ever touched the path) is the server's 404 — an unknown id — in
// both modes.
async function historyList(cfg, history, id, values) {
  const limit = values.limit;
  let env;
  if (cfg.mode() === "remote") {
    const q = limit != null ? `?limit=${encodeURIComponent(limit)}` : "";
    const r = await remote.get(cfg, `/v1/nodes/${encodeURIComponent(id)}/history${q}`, { timeoutMs: 10000 });
    if (r.transport) {
      err(`offline — could not reach server (${r.error})`);
      return 1;
    }
    if (r.status === 404) {
      const msg = r.json && r.json.error && r.json.error.message;
      err(msg || `node '${id}' has no history (unknown id)`);
      return 1;
    }
    if (r.status === 422) {
      const msg = r.json && r.json.error && r.json.error.message;
      err(`invalid request${msg ? ` — ${msg}` : ""}`);
      return 1;
    }
    if (!r.ok || !r.json) {
      err(`history error ${r.status}`);
      return 1;
    }
    env = r.json;
  } else {
    const nodesDir = cfg.nodesDir();
    if (!fs.existsSync(nodesDir)) {
      err(`no Spor graph at ${nodesDir} — run 'spor init', or set SPOR_SERVER for a team graph.`);
      return 1;
    }
    try {
      env = history.collect({ nodesDir, id, limit, emailIdx: historyEmailIndex(history, nodesDir) });
    } catch (e) {
      err(`history: ${e.message}`);
      return 1;
    }
    if (env.count === 0) {
      err(`node '${id}' has no history (unknown id)`);
      return 1;
    }
  }
  if (values.json) {
    out(JSON.stringify(env, null, 2));
    return 0;
  }
  out(history.renderList(env));
  return 0;
}

// The entry arm: one revision's diff + change type (the "diff sub-fetch"), with
// --content also printing the full node at that revision. Remote dispatches GET
// /v1/nodes/{id}/history/{sha}; local runs the git-show twin. Error codes map to
// the same one-line messages the server raises (commit not found / did not change
// the node).
async function historyEntry(cfg, history, id, sha, values) {
  let entry;
  if (cfg.mode() === "remote") {
    const r = await remote.get(
      cfg,
      `/v1/nodes/${encodeURIComponent(id)}/history/${encodeURIComponent(sha)}`,
      { timeoutMs: 10000 }
    );
    if (r.transport) {
      err(`offline — could not reach server (${r.error})`);
      return 1;
    }
    if (r.status === 404) {
      const msg = r.json && r.json.error && r.json.error.message;
      err(msg || historyEntryError("bad_sha", id, sha));
      return 1;
    }
    if (r.status === 422) {
      const msg = r.json && r.json.error && r.json.error.message;
      err(`invalid request${msg ? ` — ${msg}` : ""}`);
      return 1;
    }
    if (!r.ok || !r.json) {
      err(`history error ${r.status}`);
      return 1;
    }
    entry = r.json;
  } else {
    const nodesDir = cfg.nodesDir();
    if (!fs.existsSync(nodesDir)) {
      err(`no Spor graph at ${nodesDir} — run 'spor init', or set SPOR_SERVER for a team graph.`);
      return 1;
    }
    const r = history.collectEntry({ nodesDir, id, sha, emailIdx: historyEmailIndex(history, nodesDir) });
    if (!r.ok) {
      err(historyEntryError(r.code, id, sha));
      return 1;
    }
    entry = r.response;
  }
  if (values.json) {
    out(JSON.stringify(entry, null, 2));
    return 0;
  }
  out(history.renderEntry(entry, { content: !!values.content }));
  return 0;
}

// Map a local collectEntry() failure code to the same one-line message the server
// returns for the matching 404/500, so the entry arm reads identically in both
// modes (norm-spor-cli-mode-parity).
function historyEntryError(code, id, sha) {
  switch (code) {
    case "bad_sha":
    case "empty":
      return `commit '${sha}' not found`;
    case "not_in_history":
      return `commit '${sha}' did not change node '${id}'`;
    default:
      return `could not read revision '${sha}' of '${id}'`;
  }
}

// --- spor lens / render-lens: view a saved lens (REMOTE only) ---------------
// (task-cc-spor-cli-lens-render) Lens RENDERING lives entirely server-side in
// the engine half (lib-engine; art-cc-lib-boundary moved it out of the client
// repo, history-cleaned, to enforce the engine→client-core dependency
// direction). So this verb is a thin remote client: it discovers lenses via
// GET /v1/lenses and renders one via GET /v1/lens/<id>/render?format=text|json
// (API.md §3). No id => the catalog (the discovery step before you render).
// Like the other remote-only verbs (whoami/invite/token), local mode degrades
// with one clear line and no crash — there is no local renderer to fall back to.
async function cmdLens(cfg, args) {
  if (cfg.mode() !== "remote") {
    out("lens rendering needs a team graph — lenses are rendered server-side.");
    out("  set SPOR_SERVER/SPOR_TOKEN (see 'spor join') to view lenses.");
    return 0;
  }
  const wantJson = args.includes("--json");
  // --format text|json picks the server rendering; --json forces json + raw
  // machine output (the view tree / catalog), matching the rest of the CLI.
  let format = optVal(args, "format") || (wantJson ? "json" : "text");
  if (format !== "text" && format !== "json") {
    err(`invalid --format '${format}' — use 'text' or 'json'`);
    return 1;
  }

  const id = args.find((a) => !a.startsWith("--"));

  // No id => list the catalog (GET /v1/lenses).
  if (!id) {
    const r = await remote.get(cfg, "/v1/lenses", { timeoutMs: 6000 });
    if (r.transport) {
      err(`offline — could not reach server (${r.error})`);
      return 1;
    }
    if (!r.ok) {
      err(`lens list error ${r.status}`);
      return 1;
    }
    if (wantJson) {
      out(JSON.stringify(r.json));
      return 0;
    }
    const lenses = (r.json && r.json.lenses) || [];
    if (!lenses.length) {
      out("no lenses in the team graph");
      return 0;
    }
    out("Lenses (render with: spor lens <id>):");
    for (const l of lenses) {
      out(`  ${l.id}${l.type && l.type !== "lens" ? `  [${l.type}]` : ""}${l.title ? `  ${l.title}` : ""}`);
      if (l.summary) out(`      ${l.summary}`);
    }
    return 0;
  }

  // Render one lens. Pass through any --PARAM VALUE flags as lens params
  // (?key=value), skipping the CLI's own --format/--json. The server discards a
  // caller-supplied viewer param and binds $viewer from the token, so a
  // --viewer flag here is harmless (ignored server-side).
  const RESERVED = new Set(["format", "json"]);
  const qs = [`format=${encodeURIComponent(format)}`];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (RESERVED.has(key)) continue;
    const val = args[i + 1] != null && !args[i + 1].startsWith("--") ? args[++i] : "";
    if (val !== "") qs.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
  }
  const r = await remote.get(cfg, `/v1/lens/${encodeURIComponent(id)}/render?${qs.join("&")}`, { timeoutMs: 10000 });
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (r.status === 404) {
    err(`no lens or workspace '${id}'`);
    // The 404 body carries the catalog so a caller that guessed an id learns
    // what it could have asked for (API.md render_lens / issue-cc-lens-discovery).
    const avail = (r.json && r.json.available) || [];
    if (avail.length) err(`  available: ${avail.join(", ")}`);
    else err(`  run 'spor lens' to list available lenses.`);
    return 1;
  }
  if (!r.ok) {
    // Engine failures (missing param, broken blocks) come back 422 with the
    // message verbatim — surface it rather than a bare status.
    const msg = r.json && r.json.error && r.json.error.message;
    err(`lens render error ${r.status}${msg ? `: ${msg}` : ""}`);
    return 1;
  }
  // text => plain rendering on stdout; json => the raw view tree.
  out(format === "json" ? (r.json != null ? JSON.stringify(r.json) : r.text) : (r.text != null ? r.text : ""));
  return 0;
}

// --- spor run: start a workflow run / inspect a run (REMOTE only) -----------
// (task-spor-workflow-run-cli-verbs) Workflow execution lives entirely server-
// side in the engine half (the run reducer in lib-engine); the client never
// runs a workflow locally. So this verb is a thin remote client over two routes
// (API.md §3), the shell twin of the run_workflow MCP tool:
//   spor run <workflow-id> [--inputs <json>]  -> POST /v1/workflows/{id}/run
//   spor run status <run-id>                  -> GET  /v1/runs/{id}
// Like the other remote-only verbs (lens/whoami/invite), local mode degrades
// with one clear line and no crash — there is no local run engine to fall back
// to. `status` is the reserved sub-verb; a workflow id is a `wf-…` slug, so it
// never collides with it.
async function cmdRun(cfg, { values, positionals }) {
  if (cfg.mode() !== "remote") {
    out("workflow runs need a team graph — the workflow engine runs server-side.");
    out("  set SPOR_SERVER/SPOR_TOKEN (see 'spor join') to start or inspect runs.");
    return 0;
  }
  const sub = positionals[0];
  if (!sub) {
    err("usage: spor run <workflow-id> [--inputs <json>]");
    err("       spor run status <run-id>");
    return 1;
  }
  if (sub === "status") {
    const runId = positionals[1];
    if (!runId) {
      err("usage: spor run status <run-id>");
      return 1;
    }
    return runStatus(cfg, runId, !!values.json);
  }
  return runStart(cfg, sub, values);
}

// Render a run's per-step states to stdout. Handles BOTH shapes the server
// returns: the compact run-start summary (`state.steps[id]` is a status STRING,
// runStateSummary) and the full GET reducer_state (`state.steps[id]` is an
// object carrying `.status`). A null/absent state prints nothing.
function renderRunState(state, indent = "  ") {
  if (!state || typeof state !== "object") return;
  if (state.status) out(`${indent}state: ${state.status}${state.halt_reason ? ` (halt: ${state.halt_reason})` : ""}`);
  const steps = state.steps || {};
  const ids = Object.keys(steps);
  if (!ids.length) return;
  out(`${indent}steps:`);
  for (const id of ids) {
    const s = steps[id];
    const status = typeof s === "string" ? s : (s && s.status) || "?";
    out(`${indent}  ${id}: ${status}`);
  }
}

// `spor run <workflow-id> [--inputs <json>]` -> POST /v1/workflows/{id}/run.
// --inputs is a JSON OBJECT (the ${inputs.x} interpolation values); a non-object
// or unparseable value is rejected client-side before any request. The server
// only STARTS the run (creates the workflow-run node + init reducer); workers
// then claim ready steps over the claim API — this never executes effects.
async function runStart(cfg, workflowId, values) {
  let inputs;
  if (values.inputs != null) {
    try {
      inputs = JSON.parse(values.inputs);
    } catch (e) {
      err(`--inputs is not valid JSON: ${e.message}`);
      return 1;
    }
    if (inputs == null || typeof inputs !== "object" || Array.isArray(inputs)) {
      err("--inputs must be a JSON object, e.g. --inputs '{\"ref\":\"v1.2.0\"}'");
      return 1;
    }
  }
  const body = inputs ? { inputs } : {};
  const r = await remote.post(cfg, `/v1/workflows/${encodeURIComponent(workflowId)}/run`, body, { timeoutMs: 15000 });
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (r.status === 404) {
    err(`no such workflow: ${workflowId}`);
    return 1;
  }
  if (!r.ok) {
    // A 409 (not active / concurrency cap) and a 422 (not a workflow / bad
    // payload) carry the load-bearing why in the message — surface it verbatim.
    const msg = r.json && r.json.error && r.json.error.message;
    const code = r.json && r.json.error && r.json.error.code;
    err(`run error ${r.status}${code ? ` (${code})` : ""}${msg ? `: ${msg}` : ""}`);
    return 1;
  }
  const j = r.json || {};
  if (values.json) {
    out(JSON.stringify(j, null, 2));
    return 0;
  }
  out(`run started: ${j.run_id}`);
  if (j.workflow) out(`  workflow: ${j.workflow}${j.workflow_version != null ? ` (v${j.workflow_version})` : ""}`);
  renderRunState(j.state);
  if (j.run_id) out(`  inspect: spor run status ${j.run_id}`);
  return 0;
}

// `spor run status <run-id>` -> GET /v1/runs/{id}: the full run record (status,
// project, title, initiator, workflow + version, per-step states, timestamps).
async function runStatus(cfg, runId, wantJson) {
  const r = await remote.get(cfg, `/v1/runs/${encodeURIComponent(runId)}`, { timeoutMs: 8000 });
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (r.status === 404) {
    err(`no such run: ${runId}`);
    return 1;
  }
  if (!r.ok) {
    const msg = r.json && r.json.error && r.json.error.message;
    const code = r.json && r.json.error && r.json.error.code;
    err(`run status error ${r.status}${code ? ` (${code})` : ""}${msg ? `: ${msg}` : ""}`);
    return 1;
  }
  const j = r.json || {};
  if (wantJson) {
    out(JSON.stringify(j, null, 2));
    return 0;
  }
  out(`run ${j.run_id}${j.status ? ` — ${j.status}` : ""}`);
  if (j.title) out(`  ${j.title}`);
  if (j.workflow) out(`  workflow: ${j.workflow}${j.workflow_version != null ? ` (v${j.workflow_version})` : ""}`);
  if (j.project) out(`  project: ${j.project}`);
  if (j.initiator) out(`  initiator: ${j.initiator}`);
  renderRunState(j.state);
  if (j.timestamps) {
    if (j.timestamps.started_at) out(`  started: ${j.timestamps.started_at}`);
    if (j.timestamps.last_event_at) out(`  last event: ${j.timestamps.last_event_at}`);
  }
  return 0;
}

// --- spor share: mint a shareable read-only view link (REMOTE only) ----------
// (task-spor-share-lens-cli-verb) The shell front-door for POST /v1/lens/{id}/
// ticket (API.md §3): mint a signed, expiring, read-only render ticket for a
// lens OR workspace node and print the shareable view link ready to paste. The
// ticket replaced embedding the sharer's PAT in shared URLs
// (dec-cc-lens-share-render-tickets): it records the authenticated caller as the
// sharer, binds $viewer to that recorded identity (the render shows a "Viewing
// as <sharer>" banner), and carries NO write scope — so a pasted link can never
// leak a write-capable credential. Like the other render-side verbs (lens/run)
// the ticket is minted and signed server-side, so this is a thin remote client;
// local mode degrades with one clear line and no crash.
//   spor share <lens-id> [--expires <Nd>]  -> POST /v1/lens/{id}/ticket {expires?}
// --expires ("<N>d" or an ISO date; server default 7d, max 30d) rides the body
// verbatim so the server stays the single validator of the window — a bad value
// or an unbound (no-person) token comes back 422 with the why.
async function cmdShare(cfg, { values, positionals }) {
  if (cfg.mode() !== "remote") {
    out("sharing needs a team graph — render tickets are minted server-side.");
    out("  set SPOR_SERVER/SPOR_TOKEN (see 'spor join') to share a lens.");
    return 0;
  }
  const id = positionals[0];
  if (!id) {
    err("usage: spor share <lens-id> [--expires <Nd>]");
    return 1;
  }
  const body = values.expires != null ? { expires: values.expires } : {};
  const r = await remote.post(cfg, `/v1/lens/${encodeURIComponent(id)}/ticket`, body, { timeoutMs: 8000 });
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (r.status === 404) {
    err(`no lens or workspace '${id}'`);
    return 1;
  }
  if (!r.ok) {
    // A 422 carries the load-bearing why — a bad --expires window, or no_person
    // (the token isn't bound to a person node, so there is no sharer to record).
    // Surface it verbatim; add a hint for the no_person case.
    const msg = r.json && r.json.error && r.json.error.message;
    const code = r.json && r.json.error && r.json.error.code;
    err(`share error ${r.status}${code ? ` (${code})` : ""}${msg ? `: ${msg}` : ""}`);
    if (code === "no_person") err("  your token must be bound to a person node to mint a share ticket — check 'spor whoami'.");
    return 1;
  }
  const j = r.json || {};
  if (values.json) {
    out(JSON.stringify(j, null, 2));
    return 0;
  }
  out(`Shareable read-only link${j.exp ? ` (expires ${j.exp})` : ""}:`);
  out(`  ${j.url || "(no url returned)"}`);
  // The recipient renders the view AS the recorded sharer (the server shows a
  // "Viewing as <sharer>" banner) — read-only, no sign-in, no write scope.
  const who = j.sharer_person_id ? ` as ${j.sharer_person_id}` : "";
  const what = j.lens_id ? ` ${j.lens_id}` : "";
  out(`Recipients view${what}${who} — read-only, no sign-in, no write access.`);
  return 0;
}

// compile / brief / validate are LOCAL-graph verbs: byte-identical passthrough
// to lib/compile.js / lib/validate.js, which read $SPOR_HOME/nodes. In REMOTE
// mode that dir is absent, so the old passthrough exited with a bare
// "no Spor graph at ~/.spor/nodes" — reads like a broken install
// (issue-spor-cli-remote-mode-local-verbs). So they branch on mode: dispatch to
// the server where an equivalent exists (brief/compile, mirroring the
// /spor:brief skill), fail fast naming the remote path where it does not
// (validate, compile --skeleton). An explicit --nodes names a local checkout on
// purpose, so it always takes the local path even under a configured server —
// which also keeps local-mode output byte-identical (norm-cc-byte-identical-refactor).
function namesLocalGraph(args) {
  return args.includes("--nodes");
}

async function cmdCompile(cfg, verb, args) {
  // brief <id> is sugar for compile --root <id>.
  let compileArgs = args;
  if (verb === "brief") {
    const id = args[0];
    if (!id) {
      err("usage: spor brief <id>");
      return 1;
    }
    compileArgs = ["--root", id, ...args.slice(1)];
  }
  if (cfg.mode() === "remote" && !namesLocalGraph(compileArgs)) {
    return await compileRemote(cfg, compileArgs);
  }
  return passthrough("compile.js", compileArgs);
}

// Compile a node's remote briefing the way the /spor:brief skill does: the raw
// node (GET /v1/nodes/<id>) plus a root-walk /v1/digest for its neighborhood,
// concatenated. Shared by compileRemote (brief / compile --root) and
// compileBriefing (dispatch) so the two can't drift — dispatch used to embed
// only the bare node, a thinner standing context than an interactive brief
// (issue-spor-dispatch-briefing-omits-neighborhood). Returns
// {transport,error} | {ok:false,status} | {ok:true,status,text}; the
// neighborhood is fail-soft (a failed/empty digest just yields the raw node).
async function remoteNodeBriefing(cfg, { root, project }) {
  const r = await remote.get(cfg, `/v1/nodes/${encodeURIComponent(root)}`, { timeoutMs: 8000 });
  if (r.transport) return { transport: true, error: r.error, text: "" };
  if (!r.ok) return { ok: false, status: r.status, text: "" };
  const raw = (r.json && r.json.raw) || r.text || "";
  // /v1/digest {root} runs the server-side structural root-walk (the same path
  // query_graph(root_id=…) and `compile --root` take), so the neighborhood is
  // the node's actual lineage instead of a title/summary-seeded free-text
  // approximation (issue-cc-node-id-briefing-digest-approximation).
  const d = await remote.post(cfg, "/v1/digest", project ? { root, project } : { root }, { timeoutMs: 8000 });
  const neighborhood = d.ok && d.json && d.json.found !== false ? d.json.text || "" : "";
  return { ok: true, status: r.status, text: neighborhood ? `${raw}\n\n${neighborhood}` : raw };
}

// The remote arm of compile/brief. Mirrors the /spor:brief skill's remote
// resolution: a node id -> the raw node plus a root-walk /v1/digest for its
// neighborhood; free text -> POST /v1/digest. --skeleton has no server
// equivalent (it writes a local briefing-node file), so it fails fast. Output
// matches the local "nothing relevant" contract: exit 0 with empty stdout.
async function compileRemote(cfg, args) {
  const root = optVal(args, "root");
  const query = optVal(args, "query");
  const project = optVal(args, "project");
  const outFile = optVal(args, "out");
  const minSim = optVal(args, "min-sim");

  if (args.includes("--skeleton")) {
    err("compile --skeleton is local-only — it writes a briefing-node skeleton from a local graph.");
    err("  in remote mode the server compiles; use 'spor brief <id>' for a node's briefing,");
    err("  or run in local mode (unset SPOR_SERVER, or pass --nodes <dir>) against a checkout.");
    return 1;
  }
  if (!root && !query) {
    err('usage: spor compile (--root <id> | --query "text") [--digest] [--project <slug>]');
    return 1;
  }

  let text = "";
  if (root) {
    const b = await remoteNodeBriefing(cfg, { root, project });
    if (b.transport) {
      err(`offline — could not reach server (${b.error})`);
      return 1;
    }
    if (b.status === 404) {
      err(`no such node: ${root}`);
      return 1;
    }
    if (!b.ok) {
      err(`error ${b.status}`);
      return 1;
    }
    text = b.text;
  } else {
    const body = { query };
    if (project) body.project = project;
    if (minSim != null) body.min_sim = parseFloat(minSim);
    const d = await remote.post(cfg, "/v1/digest", body, { timeoutMs: 8000 });
    if (d.transport) {
      err(`offline — could not reach server (${d.error})`);
      return 1;
    }
    if (!d.ok) {
      err(`digest error ${d.status}`);
      return 1;
    }
    if (!d.json || d.json.found === false) return 0; // nothing relevant — mirror local empty
    text = d.json.text || "";
  }

  if (!text) return 0;
  if (outFile) {
    try {
      fs.writeFileSync(outFile, text);
    } catch (e) {
      err(`could not write ${outFile}: ${e.message}`);
      return 1;
    }
  } else {
    out(text);
  }
  return 0;
}

// validate lints a LOCAL graph (lib/validate.js). Remote mode has no
// whole-graph lint endpoint — the server validates every write per node — so
// fail fast naming that, unless --nodes points at a local checkout to lint.
function cmdValidate(cfg, args) {
  if (cfg.mode() === "remote" && !namesLocalGraph(args)) {
    err("validate lints a LOCAL graph; in remote mode the server validates every write,");
    err("  so there is no whole-graph lint over the API. Point --nodes at a local checkout");
    err("  to lint it, or unset SPOR_SERVER to validate the local graph home.");
    return 1;
  }
  return passthrough("validate.js", args);
}

// query is the structured node/edge enumeration `get`/`next`/`compile --query`
// are not (task-spor-local-graph-query-verb). Dual-mode (task-spor-cli-query-
// remote-mode): local mode is byte-identical passthrough to lib/query.js over the
// local nodes dir; remote mode runs the SAME query.js over the TEAM graph. There
// is no server-side structured-enumeration endpoint (the query-like REST surfaces
// are /v1/digest semantic search and saved lenses, neither a predicate filter),
// so remote mode fetches the graph the way graph-wide structural sweeps are done
// (GET /v1/export) and queries it locally — see queryRemote. An explicit --nodes
// names a local checkout, so it always takes the local path even under a server.
async function cmdQuery(cfg, args) {
  if (cfg.mode() === "remote" && !namesLocalGraph(args)) {
    return await queryRemote(cfg, args);
  }
  return passthrough("query.js", args);
}

// The remote arm of query. With no server enumeration endpoint, query the team
// graph the documented way: download the GET /v1/export tarball — the server's
// nodes/ reproduced byte-for-byte (the read-replica path, the same the `spor
// export` verb wraps) — extract it to a temp dir, and run the SAME local query.js
// over it via --nodes. Output and filtering are byte-identical to a local query
// because it IS the local code path, just over the freshly-fetched team graph
// (norm-spor-cli-mode-parity). gzip on the wire (the server compresses ?gzip=1);
// we gunzip when the magic bytes are present, so an older server that ignores the
// flag (plain tar) still works. The temp dir is always cleaned up.
async function queryRemote(cfg, args) {
  const fetched = await fetchRemoteExportNodes(cfg, "query");
  if (fetched.error) return 1; // already reported
  try {
    return passthrough("query.js", [...args, "--nodes", fetched.nodesDir]);
  } finally {
    fetched.cleanup();
  }
}

// Fetch the TEAM graph's nodes the documented graph-wide-sweep way (GET
// /v1/export — the server's nodes/ reproduced byte-for-byte) and extract them to
// a temp nodes dir. Shared by the remote arm of `spor query` and `spor repos
// tags` so both run their local code over a freshly-fetched team graph
// (norm-spor-cli-mode-parity). gzip on the wire when the server honors it; we
// gunzip on the magic bytes so an older plain-tar server still works. Returns
// {nodesDir, cleanup} on success, or {error:true} after printing a `<label>
// error …` line (the fail-clean contract). The caller MUST call cleanup().
async function fetchRemoteExportNodes(cfg, label) {
  const r = await remote.download(cfg, "/v1/export?gzip=1", { timeoutMs: 120000 });
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return { error: true };
  }
  if (!r.ok) {
    let msg = "";
    try {
      msg = JSON.parse(r.buffer.toString("utf8")).error.message;
    } catch {
      /* non-JSON body */
    }
    err(`${label} error ${r.status}${msg ? `: ${msg}` : ""}`);
    return { error: true };
  }
  let buffer = r.buffer;
  if (buffer.length > 1 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      buffer = require("zlib").gunzipSync(buffer);
    } catch (e) {
      // A corrupt/truncated body: surface a clean line, not a raw stack trace
      // (the fail-clean contract the rest of this arm keeps).
      err(`${label} error: could not decode the server's export (${e.message})`);
      return { error: true };
    }
  }
  const tar = require(path.join(ROOT, "lib", "tar.js"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `spor-${label}-`));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const nodesDir = path.join(tmp, "nodes");
    fs.mkdirSync(nodesDir, { recursive: true });
    for (const e of tar.extract(buffer)) {
      const base = path.basename(e.name); // entries are nodes/<id>.md
      if (!base.endsWith(".md")) continue;
      fs.writeFileSync(path.join(nodesDir, base), e.data);
    }
    return { nodesDir, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

// `spor check` — the coupling-drift report over a diff
// (task-spor-cli-check-coupling-verb, dec-spor-coupling-norms-declared-first):
// the boundary-time consumer of the same coupling norms the post-tool nudge
// serves at edit time (one matcher, lib/kernel/coupling.js). Resolve a change
// set via LOCAL git (always — the diff is where you run), load the graph's
// coupling norms (local nodes dir, or the team graph via GET /v1/export in
// remote mode, the documented graph-wide-sweep path), and report each norm
// whose `couples_when` triggers are touched while its `couples_also` targets
// are not — plus value-invariant disagreement for norms carrying
// couples_value_a/b. Advisory by default (exit 0); --strict exits 1 on
// findings for CI/pre-commit enforcement.
async function cmdCheck(cfg, args) {
  const cwd = process.cwd();
  const topR = git(cwd, ["rev-parse", "--show-toplevel"]);
  const top = topR.status === 0 ? topR.stdout.trim() : "";
  if (!top) {
    err("check: not inside a git repository (the change set is a git diff)");
    return 1;
  }
  const slug = u.projectSlug(top);
  const range = optVal(args, "range");
  const staged = args.includes("--staged");
  const strict = args.includes("--strict");
  const json = args.includes("--json");
  let files = null;
  const fi = args.indexOf("--files");
  if (fi >= 0) {
    files = [];
    for (let i = fi + 1; i < args.length && !String(args[i]).startsWith("--"); i++) files.push(args[i]);
    if (!files.length) {
      err("check: --files needs at least one path");
      return 1;
    }
  }
  if ((range ? 1 : 0) + (staged ? 1 : 0) + (files ? 1 : 0) > 1) {
    err("check: --range, --staged, and --files are mutually exclusive");
    return 1;
  }

  // The change set, as repo-relative forward-slash paths (git's own spelling).
  let changed = [];
  let rightRev = null; // where value invariants read from (--range reads the range's right side)
  if (files) {
    changed = files.flatMap((f) => {
      const abs = path.isAbsolute(f) ? f : path.resolve(cwd, f);
      // repoRelativeCandidates derives every valid repo-relative spelling
      // in-repo (literal-first, canonicalizing away from the literal only
      // when it walks out — issue-spor-windows-ci-short-path-mismatch — or
      // when an in-repo symlinked subtree gives the file two distinct
      // spellings — task-spor-coupling-matcher-symlink-alias), so a coupling
      // glob authored against either side of a tracked symlink still matches.
      // A genuinely out-of-repo --files entry has no in-repo candidate; fall
      // back to toRepoRel's single `../…` spelling rather than dropping it.
      const rels = u.repoRelativeCandidates(top, abs);
      return rels.length ? rels : [u.toRepoRel(top, abs)];
    });
  } else if (range) {
    const r = git(top, ["diff", "--name-only", range]);
    if (r.status !== 0) {
      err(`check: could not resolve --range '${range}' (${(r.stderr || "").trim().split("\n")[0]})`);
      return 1;
    }
    changed = r.stdout.split("\n").filter(Boolean);
    const i = range.lastIndexOf("..");
    rightRev = i > 0 ? range.slice(i + 2) || "HEAD" : null;
  } else if (staged) {
    const r = git(top, ["diff", "--name-only", "--cached"]);
    if (r.status !== 0) {
      err("check: git diff --cached failed");
      return 1;
    }
    changed = r.stdout.split("\n").filter(Boolean);
  } else {
    // Default: everything uncommitted vs HEAD (staged + unstaged) plus
    // untracked files — the mid-session / pre-commit superset, so an unstaged
    // edit can't silently pass. (The task sketch said "staged by default";
    // staged-only reports NOTHING for the common unstaged-working-tree case —
    // false confidence — so the default is the honest superset and --staged is
    // the narrow pre-commit view.) A repo with no commits yet falls back to
    // the index.
    const d = git(top, ["diff", "--name-only", "HEAD"]);
    if (d.status === 0) changed = d.stdout.split("\n").filter(Boolean);
    else {
      const c = git(top, ["diff", "--name-only", "--cached"]);
      if (c.status === 0) changed = c.stdout.split("\n").filter(Boolean);
    }
    const un = git(top, ["ls-files", "--others", "--exclude-standard"]);
    if (un.status === 0) changed.push(...un.stdout.split("\n").filter(Boolean));
  }
  changed = [...new Set(changed)];

  // The coupling norms: local nodes dir, or the team graph via /v1/export.
  const couplingLib = require(path.join(ROOT, "lib", "kernel", "coupling.js"));
  const scanDir = (nodesDir) => {
    let names = [];
    try {
      names = fs.readdirSync(nodesDir).sort();
    } catch {}
    return couplingLib.scanCouplingEntries((f) => fs.readFileSync(path.join(nodesDir, f), "utf8"), names);
  };
  let scan;
  let cleanupFetched = null;
  if (cfg.mode() === "remote" && !namesLocalGraph(args)) {
    const fetched = await fetchRemoteExportNodes(cfg, "check");
    if (fetched.error) return 1; // already reported (offline / HTTP error)
    cleanupFetched = fetched.cleanup;
    scan = scanDir(fetched.nodesDir);
  } else {
    const nodesDir = optVal(args, "nodes") || cfg.nodesDir();
    if (!fs.existsSync(nodesDir)) {
      err(`no graph at ${nodesDir} — run 'spor init' first`);
      return 1;
    }
    scan = scanDir(nodesDir);
  }
  try {
    const checkLib = require(path.join(ROOT, "lib", "check.js"));
    const readFile = (rel) => {
      try {
        if (rightRev) {
          const r = git(top, ["show", `${rightRev}:${rel}`]);
          return r.status === 0 ? r.stdout : null;
        }
        return fs.readFileSync(path.join(top, rel), "utf8");
      } catch {
        return null;
      }
    };
    const { checked, findings, reminders } = checkLib.runCheck({
      slug,
      changed,
      norms: scan.norms,
      repoTags: scan.repo_tags[slug] ?? [],
      readFile,
      // Declared alias map (issue-spor-coupling-matcher-reverse-symlink-gap):
      // expands a changed path already reported in its git-resolved form to
      // any config-declared alias spelling too, so a norm authored against
      // the alias still triggers/targets — not just the `--files` path,
      // whose repoRelativeCandidates only recovers a LEXICALLY-present alias.
      aliases: cfg.getObj("coupling.aliases", {}),
    });
    if (json) out(JSON.stringify({ project: slug, changed, checked, findings, reminders, strict }, null, 2));
    else out(checkLib.renderReport({ slug, changed, checked, findings, reminders }, { strict }));
    return strict && findings.length ? 1 : 0;
  } finally {
    if (cleanupFetched) cleanupFetched();
  }
}

// analytics folds a graph's git history into created-vs-completed metrics
// (task-spor-work-analytics-consumer). Unlike query/validate (no server twin) it
// is dual-mode: local mode runs the in-repo consumer (lib/analytics.js) over
// $SPOR_HOME's git history; remote mode dispatches to the server's GET
// /v1/analytics — the server owns the graph and its history there — and renders
// the returned report with the SAME renderReport so output matches local
// (task-spor-analytics-remote-cli-dispatch, norm-spor-cli-mode-parity). An
// explicit --nodes names a local checkout, so it always takes the local path even
// under a server (keeping local output byte-identical).
async function cmdAnalytics(cfg, args) {
  if (cfg.mode() === "remote" && !namesLocalGraph(args)) {
    return await analyticsRemote(cfg, args);
  }
  return passthrough("analytics.js", args);
}

// The remote arm of analytics. Maps the local CLI flags to GET /v1/analytics
// query params, fetches the JSON (machine) report, and renders it with the local
// renderReport — mirroring the analyze/renderReport façade so remote output
// matches local. --json prints the machine report exactly as local does. A
// zero-match --project scope rides back as the additive `project_warning` field,
// which we surface on stderr exactly as the local CLI does (and strip from the
// report so --json stays byte-identical to local).
async function analyticsRemote(cfg, args) {
  const qs = new URLSearchParams();
  const project = optVal(args, "project");
  if (project) qs.set("project", project);
  // --type is repeatable + comma-splittable (mirrors lib/analytics.js's multi()).
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--type" && args[i + 1] != null) {
      for (const t of args[i + 1].split(",").map((s) => s.trim()).filter(Boolean)) qs.append("type", t);
    }
  }
  // weeks/top/aging shape the window exactly as the CLI flags do; an absent flag
  // falls through to the server's kernel defaults (== the local CLI's defaults).
  for (const flag of ["weeks", "top", "aging"]) {
    const v = optVal(args, flag);
    if (v != null) qs.set(flag, v);
  }
  const query = qs.toString();
  const r = await remote.get(cfg, `/v1/analytics${query ? `?${query}` : ""}`, { timeoutMs: 10000 });
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (!r.ok || !r.json) {
    const msg = r.json && r.json.error && r.json.error.message;
    err(`analytics error ${r.status}${msg ? `: ${msg}` : ""}`);
    return 1;
  }
  const report = r.json;
  if (report.project_warning) {
    err(report.project_warning); // mirror the local CLI's stderr warning
    delete report.project_warning; // strip so the report matches local byte-for-byte
  }
  if (args.includes("--json")) {
    out(JSON.stringify(report, null, 2));
  } else {
    out(analyticsLib.renderReport(report));
  }
  return 0;
}

// schema introspects the LIVE registry — node/edge types, id prefixes, edge
// weights, the ride-along flags, the status-resolution partition, and the
// attached validate()/transitions()/get() gates — merging the seed pack with
// graph-resident overrides and tagging each entry's provenance
// (task-spor-schema-introspection-surface). The read surface that closes the
// failure mode of agents reverse-engineering the contract from lib/seed/ files
// (norm-cc-registry-is-contract). Unlike query/analytics it is NOT local-only:
// the registry exists in BOTH modes, so remote mode reflects the SERVER's live
// registry (its resident overrides) via GET /v1/schema, while local mode (or any
// --nodes) reads loadGraph().registry directly.
async function cmdSchema(cfg, args) {
  // Reserved subcommands checked ahead of the <type> positional: the packaged
  // candidate schema pack (task-spor-resident-schema-adoption-upgrade-path).
  // No node/edge type may be named `candidates` or `adopt`; the positional
  // grammar is otherwise unchanged.
  const flagValIdx = new Set();
  for (let i = 0; i < args.length; i++) if (args[i] === "--nodes" || args[i] === "--source") flagValIdx.add(i + 1);
  const first = args.find((a, i) => !a.startsWith("--") && !flagValIdx.has(i)) || null;
  if (first === "candidates") return cmdSchemaCandidates(cfg, args);
  if (first === "adopt") return cmdSchemaAdopt(cfg, args);
  // --nodes always names a local checkout (like query/analytics); local mode
  // reads the local registry. Both are the byte-identical lib/schema.js CLI.
  if (namesLocalGraph(args) || cfg.mode() !== "remote") {
    return passthrough("schema.js", args);
  }
  // Remote: the live registry (with the server graph's resident overrides) lives
  // on the server. Render its GET /v1/schema body with the SAME renderer the
  // local CLI uses (lib/schema.js present()), so output is identical across modes.
  const schemaLib = require(path.join(ROOT, "lib", "schema.js"));
  const has = (n) => args.includes(`--${n}`);
  // first non-flag, non-flag-value token = the optional <type> positional.
  const type = first;
  // ?code=1 only when a detail/--code view needs the hook source, so the common
  // overview response stays lean (mirrors the local CLI's wantCode).
  const wantCode = has("code") || type != null;
  const r = await remote.get(cfg, `/v1/schema${wantCode ? "?code=1" : ""}`, { timeoutMs: 8000 });
  if (r.transport) {
    err(`could not reach the server (${r.error}) — schema introspection needs the live registry.`);
    err(`  Read a local checkout instead:  spor schema --nodes <graph-checkout>/nodes`);
    return 1;
  }
  if (r.status === 404 || r.status === 501) {
    err(`this server does not expose GET /v1/schema yet (the introspection endpoint).`);
    err(`  Read a local checkout:    spor schema --nodes <graph-checkout>/nodes`);
    err(`  Or read one schema node:  spor get schema-<type>`);
    return 1;
  }
  if (!r.ok || !r.json) {
    err(`schema introspection failed (HTTP ${r.status})${r.json && r.json.error ? ": " + r.json.error : ""}`);
    return 1;
  }
  const only = has("edges") ? "edges" : has("nodes-only") ? "nodes" : null;
  const res = schemaLib.present(r.json, { type, only, source: optVal(args, "source"), json: has("json") });
  (res.stderr ? err : out)(res.text);
  // Overview footer: packaged candidate schemas not in this registry — the
  // same line the local lib/schema.js CLI appends (mode parity). Fail-soft:
  // the footer never breaks introspection.
  if (!type && !has("json") && !res.stderr) {
    try {
      const candLib = require(path.join(ROOT, "lib", "candidates.js"));
      const f = candLib.footerLine(candLib.loadCandidates(), r.json);
      if (f) out("\n" + f);
    } catch {
      /* ignore */
    }
  }
  return res.code;
}

// The resident copy of a candidate schema in the ACTIVE graph. Local mode (or
// --nodes) reads nodes/<id>.md; remote mode GETs /v1/nodes/{id} (404 = not
// adopted). Returns { resident: node|null, raw?, revision? } or { error }.
async function fetchResidentSchema(cfg, args, id) {
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  if (namesLocalGraph(args) || cfg.mode() !== "remote") {
    const nodesDir = optVal(args, "nodes") || cfg.nodesDir();
    const file = path.join(nodesDir, `${id}.md`);
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return { resident: null };
    }
    try {
      return { resident: graphLib.parseFrontmatter(raw, `${id}.md`), raw, revision: gitBlobSha(Buffer.from(raw)) };
    } catch (e) {
      return { error: `resident ${id} is unparseable: ${e.message}` };
    }
  }
  const r = await remote.get(cfg, `/v1/nodes/${encodeURIComponent(id)}`, { timeoutMs: 6000 });
  if (r.transport) return { error: `offline — could not reach server (${r.error})` };
  if (r.status === 404) return { resident: null };
  if (!r.ok || !r.json || typeof r.json.raw !== "string") return { error: `error ${r.status} reading ${id} from the server` };
  try {
    return { resident: graphLib.parseFrontmatter(r.json.raw, `${id}.md`), raw: r.json.raw, revision: r.json.revision || null };
  } catch (e) {
    return { error: `resident ${id} is unparseable: ${e.message}` };
  }
}

// spor schema candidates — the packaged candidate pack's read surface
// (task-spor-resident-schema-adoption-upgrade-path): every candidate with its
// adoption state against the ACTIVE graph. Dual-mode like the rest of schema.
async function cmdSchemaCandidates(cfg, args) {
  const candLib = require(path.join(ROOT, "lib", "candidates.js"));
  let cands;
  try {
    cands = candLib.loadCandidates();
  } catch (e) {
    err(String((e && e.message) || e));
    return 1;
  }
  const json = args.includes("--json");
  if (!cands.length) {
    out(json ? "[]" : "no candidate schemas ship with this package");
    return 0;
  }
  const rows = [];
  for (const c of cands) {
    const rres = await fetchResidentSchema(cfg, args, c.id);
    if (rres.error) {
      err(rres.error);
      return 1;
    }
    rows.push({ c, st: candLib.candidateState(c, rres.resident) });
  }
  if (json) {
    out(
      JSON.stringify(
        rows.map(({ c, st }) => ({
          id: c.id,
          kind: c.kind,
          type: c.declaredType,
          package_version: c.version,
          state: st.state,
          resident_version: st.resident_version || null,
          resident_status: st.resident_status || null,
        })),
        null,
        2
      )
    );
    return 0;
  }
  const pkgVersion = require(path.join(ROOT, "package.json")).version;
  out(`Candidate schemas shipped with @sporhq/spor ${pkgVersion} (inert until adopted into a graph):`);
  for (const { c, st } of rows) {
    out(`  ${c.id}  ${c.kind}:${c.declaredType}  ${c.version}`);
    out(`    ${candLib.stateLine(c, st)}`);
  }
  return 0;
}

// spor schema adopt <id> — copy a packaged candidate into the active graph as
// a graph-resident schema node, through the validated full-node write path
// (never a raw file drop), preserving the propose→activate flow: a fresh
// adopt lands `status: proposed`; --activate writes `active` (the CLI form of
// GRAPH.md's trusted-admin escape — in team mode a server activation-policy
// rejection is surfaced as-is). Idempotent and CalVer-aware on re-run: a
// resident at or past the packaged version is a no-op; a pristine older copy
// (canonical hash still equals its adopted_sha stamp) upgrades in place with
// its status preserved; a diverged or unstamped resident refuses without
// --force. See lib/candidates.js for the provenance-stamp contract.
async function cmdSchemaAdopt(cfg, args) {
  const candLib = require(path.join(ROOT, "lib", "candidates.js"));
  const has = (n) => args.includes(`--${n}`);
  const flagValIdx = new Set();
  for (let i = 0; i < args.length; i++) if (args[i] === "--nodes" || args[i] === "--source") flagValIdx.add(i + 1);
  const pos = args.filter((a, i) => !a.startsWith("--") && !flagValIdx.has(i));
  const id = pos[1] || null; // pos[0] is the reserved word "adopt"
  if (!id) {
    err("usage: spor schema adopt <schema-id> [--activate] [--force]");
    return 1;
  }
  let cands;
  try {
    cands = candLib.loadCandidates();
  } catch (e) {
    err(String((e && e.message) || e));
    return 1;
  }
  // Accept the schema node id or the type it declares (adopt member-of-program).
  const cand = cands.find((c) => c.id === id || c.declaredType === id);
  if (!cand) {
    err(`no packaged candidate '${id}'${cands.length ? ` — available: ${cands.map((c) => c.id).join(", ")}` : " (this package ships none)"}`);
    return 1;
  }

  const local = namesLocalGraph(args) || cfg.mode() !== "remote";
  const nodesDir = local ? optVal(args, "nodes") || cfg.nodesDir() : null;
  const targetLine = local && optVal(args, "nodes") ? `  -> local ${nodesDir}` : writeTargetLine(cfg);

  const rres = await fetchResidentSchema(cfg, args, cand.id);
  if (rres.error) {
    err(rres.error);
    return 1;
  }
  const st = candLib.candidateState(cand, rres.resident);

  if (st.state === "superseded-by-seed") {
    err(`${cand.id} now ships in the seed pack — the registry already has it${st.resident_version ? "; retire the resident copy instead (status: retired)" : ""}`);
    return 1;
  }
  if (st.state === "current") {
    out(`up to date: ${cand.id} @ ${st.resident_version}${st.resident_status ? ` (status: ${st.resident_status})` : ""}`);
    out(targetLine);
    if (has("activate") && st.resident_status && st.resident_status !== "active") {
      err(`  note: --activate does not flip an already-adopted schema; change its status through the write surface (spor put-node / set_status)`);
    }
    return 0;
  }
  if ((st.state === "diverged" || st.state === "unstamped") && !has("force")) {
    err(`${cand.id}: ${candLib.stateLine(cand, st)}`);
    err(`  the resident copy is not a pristine adoption of a packaged candidate; --force overwrites it with the packaged ${cand.version}`);
    return 1;
  }

  const creating = st.state === "not-adopted";
  // Preserve the resident's status across an upgrade (an active schema stays
  // active — re-proposal ceremony belongs to non-backward-readable bumps,
  // which already demand the CalVer bump + upgrades chain); --activate is the
  // explicit trusted-admin lever in both directions.
  const status = has("activate") ? "active" : (rres.resident && rres.resident.status) || "proposed";
  const pkgVersion = require(path.join(ROOT, "package.json")).version;
  const raw = candLib.adoptMarkdown(cand, { status, pkgVersion });
  const verb = creating ? "adopted" : "upgraded";

  if (!local) {
    const entry = { node: raw, if_exists: creating ? "error" : "update" };
    if (!creating) entry.revision = rres.revision;
    const r = await remote.post(cfg, "/v1/nodes", { nodes: [entry] }, { timeoutMs: 15000 });
    if (r.transport) {
      err(`offline — could not reach server (${r.error})`);
      return 1;
    }
    const res0 = r.json && r.json.results && r.json.results[0];
    if (!(res0 && res0.ok)) {
      const top = r.json && r.json.error;
      if (top && !res0) err(`adopt error ${r.status}${top.message ? `: ${top.message}` : ""}`);
      else err(putNodeEntryError(res0, r.status, "adopt"));
      return 1;
    }
    out(`${verb}: ${cand.id} @ ${cand.version} (status: ${status})${res0.revision ? ` rev ${res0.revision}` : ""}`);
    out(targetLine);
    return 0;
  }

  if (!fs.existsSync(nodesDir)) {
    err(`no graph at ${nodesDir} — run 'spor init' first`);
    return 1;
  }
  const parsed = parsePutNode(raw, `${cand.id}.md`);
  if (parsed.error) {
    err(parsed.error);
    return 1;
  }
  const file = path.join(nodesDir, `${cand.id}.md`);
  if (!creating) {
    const current = gitBlobSha(fs.readFileSync(file));
    if (current !== rres.revision) {
      err(`adopt conflict: ${cand.id} changed since it was read — re-run`);
      return 1;
    }
  }
  const valid = validatePutNodeLocal(nodesDir, parsed.node, raw);
  if (valid.error) {
    err(valid.error);
    return 1;
  }
  fs.writeFileSync(file, raw);
  out(`${verb}: ${cand.id} @ ${cand.version} (status: ${status}) rev ${gitBlobSha(Buffer.from(raw))}`);
  out(targetLine);
  for (const w of valid.warnings || []) err(`  warning: ${w}`);
  return 0;
}

// changes — the team's recent-activity feed: "what landed / what did the agents
// write overnight / what changed since <commit>" (task-spor-changes-cli-verb).
// The shell front-door the temporal axis lacked (`next` is forward-looking,
// `compile` is semantic search). Dual-mode like analytics: remote mode wraps GET
// /v1/changes — the server owns the graph + its git history, and recent_changes
// is its MCP twin sharing one core (API.md §3); local mode runs the SAME git-log
// projection over the local nodes dir (lib/changes.js) and renders through the
// SAME renderer so output matches (norm-spor-cli-mode-parity). --since (sha|date),
// --project, and --limit narrow the feed in both modes. An explicit --nodes names
// a local checkout, so it always takes the local path even under a server.
async function cmdChanges(cfg, args) {
  if (cfg.mode() === "remote" && !namesLocalGraph(args)) {
    return await changesRemote(cfg, args);
  }
  return changesLocal(cfg, args);
}

// The remote arm: map the CLI flags to GET /v1/changes query params, fetch the
// JSON feed, and render it with the SAME renderer the local arm uses. --json
// prints the server's machine envelope verbatim. A 422 (unresolvable --since sha)
// is surfaced as a clear single line, mirroring the local bad_since error.
async function changesRemote(cfg, args) {
  const since = optVal(args, "since");
  const project = optVal(args, "project");
  const limit = optVal(args, "limit");
  const qs = new URLSearchParams();
  if (since) qs.set("since", since);
  if (project) qs.set("project", project);
  if (limit != null) qs.set("limit", limit);
  const query = qs.toString();
  const r = await remote.get(cfg, `/v1/changes${query ? `?${query}` : ""}`, { timeoutMs: 10000 });
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (r.status === 422) {
    const msg = r.json && r.json.error && r.json.error.message;
    err(`changes: ${msg || `could not resolve --since '${since}' as a commit`}`);
    return 1;
  }
  if (!r.ok || !r.json) {
    const msg = r.json && r.json.error && r.json.error.message;
    err(`changes error ${r.status}${msg ? `: ${msg}` : ""}`);
    return 1;
  }
  if (args.includes("--json")) {
    out(JSON.stringify(r.json, null, 2));
    return 0;
  }
  const changesLib = require(path.join(ROOT, "lib", "changes.js"));
  out(changesLib.renderReport(r.json));
  return 0;
}

// The local arm: the git-log projection over the local nodes dir (lib/changes.js).
// --nodes overrides the resolved home; --json stamps generated_at (the kernel
// stays time-free for deterministic tests). A bad --since sha exits 1 with the
// kernel's message (the local twin of the server's 422).
function changesLocal(cfg, args) {
  const changesLib = require(path.join(ROOT, "lib", "changes.js"));
  const nodesDir = optVal(args, "nodes") || cfg.nodesDir();
  const project = optVal(args, "project");
  // --project resolves the SAME grouping union as `next`/`analytics`
  // (graphLib.scopeFor/resolveProject): a bare slug -> its home-grouping union, a
  // repo-<slug>/grouping id pins it — so `changes --project` means one thing
  // across verbs. Build the keep() predicate from the loaded graph; deletions
  // (fm=null) drop out under a scope, matching the server. Only loaded when a
  // project is asked for, so the unscoped feed stays a lightweight git-log read.
  let keep = null;
  if (project) {
    const graphLib = require(path.join(ROOT, "lib", "graph.js"));
    let g = null;
    try { g = graphLib.loadGraph(nodesDir); } catch { /* unreadable graph -> no scoping */ }
    if (g) {
      if (!graphLib.projectKnown(g, project)) {
        err(`project '${project}' matched no repo or grouping — changes is empty (try a repo slug, a repo-<slug> node id, or a grouping id)`);
      }
      const scope = graphLib.scopeFor(g, project);
      keep = (fm) => fm != null && scope.has(graphLib.resolveProject(g, fm.project));
    }
  }
  let report;
  try {
    report = changesLib.collect({
      nodesDir,
      since: optVal(args, "since"),
      project,
      limit: optVal(args, "limit"),
      keep,
    });
  } catch (e) {
    if (e && e.code === "bad_since") {
      err(`changes: ${e.message}`);
      return 1;
    }
    throw e;
  }
  if (args.includes("--json")) {
    out(JSON.stringify({ ...report, generated_at: new Date().toISOString() }, null, 2));
    return 0;
  }
  out(changesLib.renderReport(report));
  return 0;
}

// program — the birds-eye program/progress view over `blocks` topology
// (task-spor-cli-program-verb): given a root node other work `blocks` (an
// umbrella task, a milestone), show the gating tree of everything that blocks
// it with resolution-derived progress. Dual-mode, but NOT byte-shared like
// changes/analytics: remote mode dispatches to GET /v1/program/{id} and prints
// the SERVER's own rendering straight through (like `spor lens`), since
// render_program's view-tree shape is a separate, private server-side kernel;
// local mode walks the local graph's inbound `blocks` edges itself
// (lib/program.js) and renders through its own text renderer. An explicit
// --nodes names a local checkout, so it always takes the local path even under
// a server.
// The naive `args.find((a) => !a.startsWith("--"))` (cmdLens's convention) picks
// up a PRECEDING flag's bare value as the id whenever that flag takes one — and
// unlike lens's --format (an enum keyword), this verb's --max-depth/--max-nodes/
// --nodes all take arbitrary values, so `spor program --nodes <dir> <id>` would
// silently grab <dir> as the id. Skip each value-taking flag's own value instead.
const PROGRAM_VALUE_FLAGS = new Set(["max-depth", "max-nodes", "nodes"]);
function programId(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (PROGRAM_VALUE_FLAGS.has(a.slice(2))) i++; // skip its value, not just the flag
      continue;
    }
    return a;
  }
  return null;
}

async function cmdProgram(cfg, args) {
  const id = programId(args);
  if (!id) {
    err("usage: spor program <id> [--max-depth <n>] [--max-nodes <n>] [--json]");
    return 1;
  }
  if (cfg.mode() === "remote" && !namesLocalGraph(args)) {
    return await programRemote(cfg, id, args);
  }
  return programLocal(cfg, id, args);
}

// The remote arm: GET /v1/program/{id}, format=json for --json else format=text,
// and print the server's own body verbatim — no local re-rendering, since the
// server's view-tree shape belongs to its own (separate) kernel.
async function programRemote(cfg, id, args) {
  const wantJson = args.includes("--json");
  const depth = optVal(args, "max-depth");
  const maxNodes = optVal(args, "max-nodes");
  const qs = new URLSearchParams();
  qs.set("format", wantJson ? "json" : "text");
  if (depth != null) qs.set("depth", depth);
  if (maxNodes != null) qs.set("max_nodes", maxNodes);
  const r = await remote.get(cfg, `/v1/program/${encodeURIComponent(id)}?${qs.toString()}`, { timeoutMs: 10000 });
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (r.status === 404) {
    err(`program: unknown root '${id}'`);
    return 1;
  }
  if (!r.ok) {
    const msg = r.json && r.json.error && r.json.error.message;
    err(`program error ${r.status}${msg ? `: ${msg}` : ""}`);
    return 1;
  }
  out(wantJson ? (r.json != null ? JSON.stringify(r.json) : r.text || "") : r.text != null ? r.text : "");
  return 0;
}

// The local arm: the `blocks`-edge gating-tree walk over the local nodes dir
// (lib/program.js). --nodes overrides the resolved home; --json stamps
// generated_at (the kernel stays time-free for deterministic tests). An
// unknown root exits 1 with the same message the remote 404 arm uses.
// A non-numeric --max-depth/--max-nodes value must fall back to the kernel's
// own default, not flow through as NaN — `depth >= NaN` is always false, which
// would silently DISABLE the cap instead of erroring or defaulting.
function numOpt(args, name) {
  const v = optVal(args, name);
  if (v == null || v.trim() === "") return undefined; // Number("") is 0, not NaN — guard it explicitly
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined; // negative bounds are nonsensical here too
}

function programLocal(cfg, id, args) {
  const programLib = require(path.join(ROOT, "lib", "program.js"));
  const nodesDir = optVal(args, "nodes") || cfg.nodesDir();
  const envelope = programLib.collect({
    nodesDir,
    rootId: id,
    maxDepth: numOpt(args, "max-depth"),
    maxNodes: numOpt(args, "max-nodes"),
  });
  if (envelope.found === false) {
    // Errors stay plain text regardless of --json, matching every other verb's
    // error path (changes/analytics/lens) and the remote arm's own 404 branch —
    // --json only shapes the SUCCESS envelope.
    err(`program: unknown root '${id}'`);
    return 1;
  }
  if (args.includes("--json")) {
    out(JSON.stringify({ ...envelope, generated_at: new Date().toISOString() }, null, 2));
    return 0;
  }
  out(programLib.renderReport(envelope));
  return 0;
}

// --- spor export: the nodes/ tarball (GET /v1/export) -----------------------
// (task-spor-export-cli-verb) The shell front-door for /v1/export — the ustar
// tarball of nodes/ used to seed a local read replica or bootstrap a fresh
// graph from a snapshot. Without it, users hand-rolled `curl … | tar x`.
// Dual-mode (norm-spor-cli-mode-parity): remote downloads GET /v1/export
// (?gzip=1 compresses server-side); local builds the SAME ustar format from the
// graph home's nodes/ (lib/tar.js, a faithful twin of the server's writer) and
// gzips via the zlib builtin. The tarball goes to --out, or to stdout when
// omitted so it pipes straight into tar (`spor export --gzip | tar xz`); the
// node count / size / graph head ride STDERR so they never pollute a piped
// tarball.
//
// Two more server export modes ride pass-through flags
// (task-spor-export-cli-verb-extensions), both REMOTE-ONLY — no local twin:
//   --history wraps ?history=1, a `git bundle --all` of the graph repo with full
//     commit provenance (`git clone <bundle> graph`), the customer data-exit path
//     (issue-cc-v1-export-customer-exit-gap). The server returns the bundle before
//     the gzip branch, so --gzip is a no-op there (a bundle is already packed).
//   --auth wraps ?auth=1, the admin-gated (stewards-root) backup that ALSO bundles
//     auth/*.json so a disaster restore reproduces the credential set, not just
//     nodes/ (issue-cc-backup-restore-auth-state-loss). The 403 the server raises
//     for a non-admin caller surfaces through the generic non-200 path below.
function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
async function cmdExport(cfg, { values }) {
  const gzip = !!values.gzip;
  const history = !!values.history;
  const auth = !!values.auth;
  const outPath = values.out || null;

  // --history and --auth are distinct, non-composable server modes: the history
  // bundle is a `git bundle --all` of the repo, whose .gitignore excludes auth/,
  // so it can never carry the credential files --auth bundles. Asking for both is
  // a contradiction, not a richer export.
  if (history && auth) {
    err("export: --history and --auth are different export modes — pick one (the history bundle excludes auth/ by design; use --auth for a restore bundle).");
    return 1;
  }
  // Both extra modes are remote-only — the git-bundle data-exit path and the
  // admin-gated auth backup live only on the server. Local mode has just the
  // nodes/ snapshot tarball (task-spor-export-cli-verb-extensions).
  if ((history || auth) && cfg.mode() !== "remote") {
    err(`export: --${history ? "history" : "auth"} is remote-only — set SPOR_SERVER for a team graph (local mode exports the nodes/ snapshot only).`);
    return 1;
  }
  // The server returns the ?history=1 bundle before its gzip branch (a bundle is
  // already a packfile), so ?gzip=1 is a no-op there — honor that rather than
  // forwarding it and printing a misleading "(gzip)".
  const gzipEffective = gzip && !history;
  if (gzip && history) {
    err("export: --gzip has no effect with --history (a git bundle is already packed); ignoring it.");
  }

  let buffer, head, count, skipped, authFiles;
  if (cfg.mode() === "remote") {
    const params = [];
    if (auth) params.push("auth=1");
    if (history) params.push("history=1");
    if (gzipEffective) params.push("gzip=1");
    const qs = params.length ? `?${params.join("&")}` : "";
    const r = await remote.download(cfg, `/v1/export${qs}`, { timeoutMs: 120000 });
    if (r.transport) {
      err(`offline — could not reach server (${r.error})`);
      return 1;
    }
    if (!r.ok) {
      // The admin gate (?auth=1, non-steward → 403) and the empty-repo guard
      // (?history=1, no commits → 409) surface here as the server's own message.
      let msg = "";
      try {
        msg = JSON.parse(r.buffer.toString("utf8")).error.message;
      } catch {
        /* non-JSON body */
      }
      err(`export error ${r.status}${msg ? `: ${msg}` : ""}`);
      return 1;
    }
    buffer = r.buffer;
    head = r.headers["x-substrate-head"] || "";
    count = r.headers["x-substrate-node-count"]; // absent on a history bundle / older server
    skipped = r.headers["x-substrate-skipped"];
    authFiles = r.headers["x-substrate-auth-files"]; // present only on an ?auth=1 export
  } else {
    const nodesDir = cfg.nodesDir();
    if (!fs.existsSync(nodesDir)) {
      err(`no Spor graph at ${nodesDir} — run 'spor init', or set SPOR_SERVER for a team graph.`);
      return 1;
    }
    const tar = require(path.join(ROOT, "lib", "tar.js"));
    const exported = tar.exportNodesDir(nodesDir);
    buffer = gzip ? require("zlib").gzipSync(exported.buffer) : exported.buffer;
    count = String(exported.count);
    skipped = exported.skipped ? String(exported.skipped) : undefined;
    // Best-effort graph head, the local twin of x-substrate-head; a non-git home
    // simply has none.
    const h = u.git(cfg.graphHome(), ["rev-parse", "HEAD"]);
    head = h ? h.trim() : "";
  }

  // Emit: a named file, or stdout when piping. Binary-safe in both arms. The
  // stdout write awaits its flush callback before we return — main() calls
  // process.exit(), which can truncate a still-draining pipe otherwise.
  if (outPath) {
    try {
      fs.writeFileSync(outPath, buffer);
    } catch (e) {
      err(`export: could not write ${outPath} — ${e.message}`);
      return 1;
    }
  } else {
    await new Promise((resolve, reject) => {
      process.stdout.write(buffer, (e) => (e ? reject(e) : resolve()));
    });
  }

  // Human feedback on stderr (stdout is the data channel when piping).
  let label;
  if (history) {
    label = "git history bundle"; // a git bundle has no node count
  } else {
    const n = count != null ? `${count} node${count === "1" ? "" : "s"}` : "graph";
    label = n + (authFiles ? ` + ${authFiles} auth file${authFiles === "1" ? "" : "s"}` : "");
  }
  const dest = outPath || "stdout";
  err(
    `exported ${label}${gzipEffective ? " (gzip)" : ""} → ${dest} (${humanBytes(buffer.length)})` +
      (head ? `  head ${head.slice(0, 12)}` : "")
  );
  if (skipped) err(`  ${skipped} entr${skipped === "1" ? "y" : "ies"} skipped (name too long for the tar field)`);
  return 0;
}

// --- spor merge: bring another graph's exported nodes into this one ---------
// (task-spor-cli-merge-verb) The CLI wrapper over POST /v1/merge
// (dec-spor-graph-merge-endpoint, API.md), replacing the hand-rolled curl+jq
// the pilot-to-org promotion runbook used until now. REMOTE-ONLY: the endpoint
// merges another graph's nodes INTO the team graph on the server, so there is
// no local-mode equivalent to dispatch to (the sanctioned norm-spor-cli-mode-parity
// divergence — a verb with no equivalent on the other side). Admin-gated
// (stewards→root) server-side; defaults to `mode: "plan"` per the task's explicit
// ask — nothing is written until --apply is passed.
//
// <source> is a directory of node markdown files (either a nodes/ dir itself, or
// its parent — the shape `spor export`/`tar x` produces), or a tarball file
// (gzipped or plain — the same format `spor export [--gzip]` writes), so the
// natural flow is `spor export --gzip --out pilot.tar.gz` on the pilot graph,
// then `spor merge pilot.tar.gz` against the org server.
function loadMergeSourceNodes(source) {
  let stat;
  try {
    stat = fs.statSync(source);
  } catch (e) {
    return { error: `could not read ${source} — ${e.message}` };
  }
  if (stat.isDirectory()) {
    const nodesSubdir = path.join(source, "nodes");
    const base = fs.existsSync(nodesSubdir) && fs.statSync(nodesSubdir).isDirectory() ? nodesSubdir : source;
    const files = fs.readdirSync(base).filter((f) => f.endsWith(".md"));
    return { nodes: files.map((f) => fs.readFileSync(path.join(base, f), "utf8")) };
  }
  let buf;
  try {
    buf = fs.readFileSync(source);
  } catch (e) {
    return { error: `could not read ${source} — ${e.message}` };
  }
  if (buf.length > 1 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = require("zlib").gunzipSync(buf);
    } catch (e) {
      return { error: `could not decode ${source} as gzip — ${e.message}` };
    }
  }
  const tar = require(path.join(ROOT, "lib", "tar.js"));
  const nodes = tar
    .extract(buf)
    .filter((e) => path.basename(e.name).endsWith(".md"))
    .map((e) => e.data.toString("utf8"));
  return { nodes };
}

// Render the {mode, counts, imported, deduped, remapped, conflicts, errors,
// id_map} report the same way whether it came back from a plan or an apply —
// a human summary of a merge that never guesses at server-internal shape.
// `refused` is set for a 409 apply refusal: nothing was written despite
// mode:"apply" in the response, so the trailer must not read as a success.
function renderMergeReport(report, source, { refused = false } = {}) {
  const counts = report.counts || {};
  const mode = report.mode || "plan";
  const incoming = counts.incoming || 0;
  out(`merge ${mode}: ${incoming} node${incoming === 1 ? "" : "s"} from ${source}`);
  out(`  imported   ${counts.imported || 0}`);
  out(`  deduped    ${counts.deduped || 0}`);
  out(`  remapped   ${counts.remapped || 0}`);
  out(`  conflicts  ${counts.conflicts || 0}`);
  out(`  errors     ${counts.errors || 0}`);
  const list = (label, arr, describe) => {
    if (!arr || !arr.length) return;
    out(`  ${label}:`);
    for (const e of arr) out(`    ${describe(e)}`);
  };
  list("remapped", report.remapped, (e) => `${e.id} -> ${e.new_id || "?"}`);
  list("conflicts", report.conflicts, (e) => `${e.id}${e.reason ? ` (${e.reason})` : ""}`);
  list("errors", report.errors, (e) => `${e.id || `#${e.index}`}: ${(e.errors || []).join("; ")}`);
  if (refused) {
    out(`nothing written — resolve the conflicts/errors above, or pass --force to import the clean subset anyway`);
  } else if (mode === "plan") {
    out(
      counts.conflicts || counts.errors
        ? `plan is not clean — resolve the conflicts/errors above (or pass --force to import the clean subset), then re-run with --apply`
        : `plan is clean — re-run with --apply to write`
    );
  } else {
    out(`applied ${counts.imported || 0} node${(counts.imported || 0) === 1 ? "" : "s"}`);
  }
}

async function cmdMerge(cfg, { values, positionals }) {
  const source = positionals[0];
  if (!source) {
    err("usage: spor merge <nodes-dir|tarball> [--apply] [--force] [--trust-attached-code] [--id-map <file>] [--save-id-map <file>] [--json]");
    return 1;
  }
  if (cfg.mode() !== "remote") {
    err("merge needs a team graph (remote mode) — it merges another graph's nodes INTO the server's graph.");
    return 1;
  }
  const loaded = loadMergeSourceNodes(source);
  if (loaded.error) {
    err(`merge: ${loaded.error}`);
    return 1;
  }
  if (!loaded.nodes.length) {
    err(`merge: no node files found under ${source}`);
    return 1;
  }

  let idMap;
  if (values["id-map"]) {
    try {
      idMap = JSON.parse(fs.readFileSync(values["id-map"], "utf8"));
    } catch (e) {
      err(`merge: could not read --id-map ${values["id-map"]} — ${e.message}`);
      return 1;
    }
  }

  const apply = !!values.apply;
  const body = { nodes: loaded.nodes, mode: apply ? "apply" : "plan" };
  if (idMap) body.id_map = idMap;
  if (values["trust-attached-code"]) body.trust_attached_code = true;
  if (values.force) body.force = true;

  const r = await remote.post(cfg, "/v1/merge", body, { timeoutMs: 120000 });
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (notAdminHint(r)) return 1;
  const json = !!values.json;
  if (r.status === 409) {
    const j = r.json || {};
    if (json) {
      out(JSON.stringify(j, null, 2));
    } else {
      err(`merge: apply refused (409) — the plan is not clean (conflicts or errors remain).`);
      renderMergeReport(j, source, { refused: true });
    }
    return 1;
  }
  if (!r.ok || !r.json) {
    const msg = r.json && r.json.error && r.json.error.message;
    err(`merge error ${r.status}${msg ? `: ${msg}` : ""}`);
    return 1;
  }
  const report = r.json;
  if (values["save-id-map"]) {
    try {
      fs.writeFileSync(values["save-id-map"], JSON.stringify(report.id_map || {}, null, 2));
    } catch (e) {
      err(`merge: could not write --save-id-map ${values["save-id-map"]} — ${e.message}`);
      return 1;
    }
  }
  if (json) {
    out(JSON.stringify(report, null, 2));
  } else {
    renderMergeReport(report, source);
  }
  return 0;
}

// --- spor add / capture -------------------------------------------------
// Local: write a well-formed node so a user never has to learn the frontmatter
// (issue-cc-local-mode-capture-queue-surfacing-gap). Remote: POST /v1/capture,
// where the server's ingestion model types it.
function kebab(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}
function optVal(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : null;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

function personDisplayName(n, fallback = null) {
  if (!n || typeof n !== "object") return fallback;
  return n.name || n.title || n.email || fallback;
}

function personLabelFromGraph(g, id) {
  const n = g && g.nodes && g.nodes[id];
  return n && n.type === "person" ? personDisplayName(n, id) : id;
}

function personIdForEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  return `person-${crypto.createHash("sha256").update(e).digest("hex").slice(0, 16)}`;
}

function labelledPerson(name, id) {
  return name && id && name !== id ? `${name} (${id})` : (name || id || "");
}

// An id round-trips through the frontmatter edge parser only if it is all [\w-]:
// lib/kernel/graph.js parseFrontmatter captures an edge `to:` as [\w-]+, so any
// other character makes the whole "- {type: X, to: Y}" line fail to match and
// silently vanish on read, breaking the reference without a trace. Edges we write
// locally (spor add --during/--blocks, spor ask --mention) must reject such ids
// rather than drop them — remote mode already rejects them server-side
// (issue-spor-local-add-ask-project-normalization-edge-validation).
const EDGE_ID_RE = /^[\w-]+$/;
// First [flag, id] pair whose id won't round-trip, or null when all are clean.
function firstBadEdgeId(pairs) {
  for (const [flag, id] of pairs) {
    if (id != null && !EDGE_ID_RE.test(id)) return { flag, id };
  }
  return null;
}
function edgeIdErr(bad) {
  return `invalid ${bad.flag} id "${bad.id}" — node ids may contain only letters, digits, '-' and '_'; this edge would be silently dropped on read.`;
}

// A caller-supplied --dedupe-key must satisfy the server's idempotency-key
// grammar VERBATIM (server/idempotency.js KEY_RE): the server treats a key it
// can't parse as no key at all and runs the capture UNGUARDED, so a typo'd key
// would silently buy nothing while the caller believes it is deduped. Reject it
// here instead, loudly, before the POST (task-spor-add-dedupe-key-first-class).
const DEDUPE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

// Spool a failed remote capture body to the SHARED outbox
// (graphHome/outbox/*.capture.json) — the exact queue session-start's
// drain-outbox engine replays to /v1/capture. The body is written VERBATIM so the
// retry re-sends the request that failed; a uuid filename guarantees uniqueness,
// the ms-epoch prefix keeps rough FIFO order under the drain's lexical sort. Best
// effort: returns the spool path, or null if even the write failed (so the caller
// can warn that the capture was genuinely lost rather than promise a retry that
// won't happen — issue-spor-add-cli-residual-transport-failure-silent-loss).
function spoolCapture(cfg, body) {
  try {
    const dir = path.join(cfg.graphHome(), "outbox");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `cli-${Date.now()}-${crypto.randomUUID()}.capture.json`);
    fs.writeFileSync(file, JSON.stringify(body));
    return file;
  } catch {
    return null;
  }
}

async function cmdAdd(cfg, { values, positionals }) {
  const prose = positionals[0];
  if (!prose) {
    err('usage: spor add "<text>" [--type T] [--title ...] [--project S] [--during ID] [--blocks ID] [--needed-by YYYY-MM-DD] [--dedupe-key KEY]');
    return 1;
  }
  const project = values.project || safeSlug();
  // Capture-context fields the /spor:defer skill uses (so it routes through ONE
  // verb instead of a mode branch): --during is the work this was discovered
  // during (a provenance edge); --blocks + --needed-by declare a cross-project
  // dependency (task-cc-xproject-dependency-loop) — set --project to the SERVING
  // project and the server attaches the blocks edge + deadline deterministically.
  const during = values.during || null;
  const blocks = values.blocks || null;
  const neededBy = values["needed-by"] || null;
  // --dedupe-key: the caller's OWN stable name for this capture, promoted to the
  // request's idempotency key so a retry of the same logical capture replays the
  // original instead of minting a second node. Caller-supplied only, never derived
  // from the text (dec at triage 2026-08-22): a content hash would silently collapse
  // two genuinely distinct captures that happen to share prose, which is worse than
  // the duplication it prevents. The caller that needs this — a cron monitor filing
  // a once-per-onset alert — already knows its stable marker and passes it.
  // Keyed on PRESENCE, not truthiness: `--dedupe-key ""` (an unset shell variable
  // in the caller's command line) must reach the validation below and be rejected,
  // not fall back to the random UUID — a silent fallback is precisely the "caller
  // believes it is deduped and isn't" failure this flag exists to remove.
  const dedupeKeyGiven = values["dedupe-key"] !== undefined;
  const dedupeKey = dedupeKeyGiven ? String(values["dedupe-key"]) : null;

  if (cfg.mode() === "remote") {
    // Validate only where the key does something. The server treats a key outside
    // its grammar as NO key and runs the capture unguarded, so a bad key here is a
    // hard error rather than a silent downgrade — but local mode ignores the flag
    // entirely (see below), and failing a local capture over an inert flag would
    // lose the text itself. Same placement rule as --during/--blocks, whose id
    // validation also lives in the branch that acts on them.
    if (dedupeKeyGiven && !DEDUPE_KEY_RE.test(dedupeKey)) {
      err(`invalid --dedupe-key "${dedupeKey}" — a dedupe key must start with a letter or digit and use only letters, digits, '.', '_' and '-' (max 200 chars).`);
      return 1;
    }
    // Mark whether `project` came from a user-declared --project or the ambient
    // cwd default, so the server can gate its fold-mismatch warning on an actual
    // declaration instead of false-firing on ordinary cross-repo folds
    // (task-spor-thread-explicit-project-flag). Rides the same context object
    // that spools to the outbox, so a `spor drain` replay carries it verbatim.
    const context = { project, project_explicit: Boolean(values.project) };
    if (during) context.during = during;
    if (blocks) context.blocks = blocks;
    if (neededBy) context.needed_by = neededBy;
    // Capture ingestion runs an LLM server-side (typically >6s), so the default
    // read timeout would abort a healthy request and silently drop the capture —
    // a one-shot CLI has no hook outbox to retry it (issue-spor-add-cli-timeout-silent-loss).
    // A client-generated idempotency key closes the timeout-then-server-completes
    // race (issue-spor-add-cli-duplicate-on-timeout-drain): if this POST aborts at
    // 30s but the server still finishes ingesting, the body — key included — spools
    // verbatim and `spor drain` re-POSTs the SAME key, so the server dedupes against
    // the landed capture instead of ingesting a second node. The key rides the BODY
    // (the server also accepts it as the `Idempotency-Key` header) precisely so the
    // verbatim outbox replay carries it for free, no drain-side restore needed.
    //
    // A caller-supplied --dedupe-key takes that slot instead of the random UUID
    // (task-spor-add-dedupe-key-first-class). The default UUID only dedupes ONE
    // process's own retry cycle (it dies with the process unless the body spooled);
    // a caller-chosen key dedupes across INVOCATIONS, which is what a cron monitor
    // re-filing the same onset on the next tick needs — same key, same window, the
    // original capture replays and no second node is minted.
    const body = { text: prose, context, idempotency_key: dedupeKey || crypto.randomUUID() };
    const r = await remote.post(cfg, "/v1/capture", body, { timeoutMs: 30000 });
    // Transport failure (server unreachable / >30s ingestion abort) or a transient
    // 5xx: the request never durably landed and a replay can still succeed. A
    // one-shot `spor add` has no hook loop to retry itself, so DON'T just print a
    // promise — spool the exact failed body to the shared outbox the session-start
    // drain replays, turning silent loss into a durable, retried capture
    // (issue-spor-add-cli-residual-transport-failure-silent-loss). Permanent 4xx
    // rejections (missing blocks target -> 404, bad date -> 422, bad token -> 401)
    // would only dead-letter on drain, so they fall through to the error path below.
    const retryable = r.transport || (typeof r.status === "number" && r.status >= 500);
    if (retryable) {
      const reason = r.transport ? r.error : `HTTP ${r.status}`;
      const spool = spoolCapture(cfg, body);
      if (spool) {
        err(`offline — capture not shipped (${reason}). Spooled to ${spool}; run 'spor drain' to ship it (or it drains on your next Spor session).`);
      } else {
        err(`offline — capture not shipped (${reason}) and could not be spooled — capture lost. Re-run when the server is reachable.`);
      }
      return 1;
    }
    if (!r.ok) {
      // Surface the deterministic cross-project rejections the server makes
      // before any model call (missing blocks target -> 404, bad date -> 422).
      err(`capture error ${r.status}`);
      return 1;
    }
    const ids = (r.json && (r.json.ids || r.json.node_ids)) || [];
    // `idempotent_replay` means the server matched this key to a capture it had
    // already committed and handed back the original ids without re-ingesting. Say
    // so rather than printing a bare "captured": for a --dedupe-key caller that IS
    // the success signal (the guard worked), and printing it as a fresh capture
    // would hide exactly the duplicate-suppression the key was passed to get.
    const replayed = Boolean(r.json && r.json.idempotent_replay);
    const suffix = replayed ? " (idempotent replay — the original capture, no new node)" : "";
    out(ids.length ? `captured: ${ids.join(", ")}${suffix}` : `captured (${(r.json && r.json.status) || "ok"})${suffix}`);
    // Self-heal: a pure-CLI user has no Claude Code session to run the drain, so a
    // successful capture (proof the server is reachable) is the moment to flush any
    // backlog the fail-open spool stranded (task-spor-cli-outbox-drain-verb). Only
    // runs when there IS a spool, is bounded, and never affects the add's success.
    // Run this BEFORE the banner write: stdout EPIPE exits the process (see the
    // handler near the top of this file), so a consumer that only wants the first
    // line (`spor add ... | head -n1`) must not be able to cut the process off
    // before the drain has had a chance to run (codex merge-gate finding,
    // task-spor-cli-write-banner-mode-echo).
    await opportunisticDrain(cfg);
    out(writeTargetLine(cfg));
    return 0;
  }

  // local: hand the user a typed, validated node file
  //
  // --dedupe-key has nothing to guard here: the node file is written synchronously
  // by this process, so there is no in-flight request that can land server-side
  // while the client reports failure — the race the key exists for is a REMOTE
  // transport race. Say so on stderr rather than accepting the flag silently: a
  // caller that believes it is deduped and isn't is exactly the failure this
  // feature was added to remove. The capture itself still proceeds — including
  // for a key the remote branch would have rejected: the value is never read
  // here, so refusing to write the node would lose the capture over a flag that
  // does nothing.
  if (dedupeKeyGiven) {
    err("note: --dedupe-key is a remote-mode guard (it rides the capture idempotency key); local mode writes the node synchronously, so there is no retry race to dedupe — the flag is ignored.");
  }
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  const nodesDir = cfg.nodesDir();
  if (!fs.existsSync(nodesDir)) {
    err(`no graph at ${nodesDir} — run 'spor init' first`);
    return 1;
  }
  // Reject an edge target id that wouldn't round-trip through the frontmatter
  // parser before we write the node — otherwise the edge silently vanishes on
  // the next read (issue-spor-local-add-ask-project-normalization-edge-validation).
  const badEdge = firstBadEdgeId([["--during", during], ["--blocks", blocks]]);
  if (badEdge) {
    err(edgeIdErr(badEdge));
    return 1;
  }
  // Normalize an explicit --project the same way an inferred slug already is
  // (safeSlug -> projectSlug), so `--project My_Repo` files the node under
  // `my-repo` instead of stamping the verbatim, non-canonical value the server
  // would have rejected. safeSlug() is already normalized, so this only bites the
  // explicit flag; a flag with no slug characters is a hard error, not a silent
  // empty stamp (issue-spor-local-add-ask-project-normalization-edge-validation).
  const localProject = values.project ? u.slugify(values.project) : project;
  if (values.project && !localProject) {
    err(`invalid --project "${values.project}" — it has no slug characters (expected ^[a-z0-9][a-z0-9-]*$).`);
    return 1;
  }
  const type = values.type || "task";
  const title = values.title || prose.split(/\s+/).slice(0, 10).join(" ");
  const summary = prose.length > 500 ? prose.slice(0, 497) + "..." : prose;

  let g;
  try {
    g = graphLib.loadGraph(nodesDir);
  } catch (e) {
    err(`could not load graph: ${e.message}`);
    return 1;
  }
  const prefixes = (g.registry && g.registry.prefixesFor(type)) || null;
  const prefix = prefixes && prefixes[0] ? prefixes[0] : `${type}-`;
  let id = values.id || `${prefix}${kebab(title) || today()}`;
  // uniquify against existing files
  let n = 1;
  let base = id;
  while (fs.existsSync(path.join(nodesDir, `${id}.md`))) id = `${base}-${++n}`;

  // Local equivalents of the capture-context fields: --during -> a derived-from
  // edge (the provenance the distiller would draw), --blocks -> a blocks edge,
  // --needed-by -> the needed_by deadline field. So the same `spor add` line the
  // /spor:defer skill runs lands the same lineage locally as remote.
  const edgeLines = [];
  if (during) edgeLines.push(`  - {type: derived-from, to: ${during}}`);
  if (blocks) edgeLines.push(`  - {type: blocks, to: ${blocks}}`);
  const edgesBlock = edgeLines.length ? `edges:\n${edgeLines.join("\n")}\n` : "";
  const neededByLine = neededBy ? `needed_by: ${neededBy}\n` : "";
  const md = `---\nid: ${id}\ntype: ${type}\nrepo: ${localProject}\ntitle: ${title.replace(/\n/g, " ")}\nsummary: ${summary.replace(/\n/g, " ")}\n${neededByLine}${edgesBlock}date: ${today()}\n---\n\n${prose}\n`;
  // validate before writing (parse, then the same rules lib/validate enforces)
  let node;
  try {
    node = graphLib.parseFrontmatter(md, `${id}.md`);
  } catch (e) {
    err(`invalid node: ${e.message}`);
    return 1;
  }
  const v = graphLib.validateNode(g, node);
  if (!v.ok) {
    err(`invalid node:\n  ${v.errors.join("\n  ")}`);
    return 1;
  }
  fs.writeFileSync(path.join(nodesDir, `${id}.md`), md);
  out(`added ${id} (${type})`);
  out(writeTargetLine(cfg));
  out(`  edit it to add edges/detail; 'spor next' will surface it.`);
  return 0;
}

// --- spor ask -----------------------------------------------------------
// File a question the graph could not answer — the CLI surface for /spor:ask, so
// the skill routes through ONE verb instead of a remote-curl-vs-local-file mode
// branch (task-cc-spor-skills-route-through-cli-drop-mode-prose), the same shape
// as add/correct. Without it a question the digest gate can't answer evaporates
// instead of becoming a routed node (task-cc-ask-question-skill). Remote: POST
// /v1/questions (ask_question's REST twin) — the server mints the question id,
// routes it to the steward of the closest relevance-neighborhood node (unrouted,
// visible to everyone, when none matches), and attributes it to the token. Local:
// write the question node file ourselves and validate, so a solo user's question
// still lands as an open, queueable node that `spor next` surfaces.
async function cmdAsk(cfg, { values, positionals }) {
  const text = positionals[0];
  if (!text) {
    err('usage: spor ask "<question>" [--title ...] [--mention ID]... [--project S]');
    return 1;
  }
  const toList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const mentions = toList(values.mention);
  const title = values.title || null;
  // --project is OPTIONAL on purpose: remote routing derives the project from the
  // question's relevance neighborhood (then the asker's home project), so only an
  // explicit --project overrides that — pass it for a mention-less question whose
  // neighborhood would otherwise yield nothing (API.md POST /v1/questions). Local
  // mode has no router, so it falls back to the cwd slug to stamp the node's repo.
  const project = values.project || null;

  if (cfg.mode() === "remote") {
    const body = { text };
    if (title) body.title = title;
    if (mentions.length) body.mentions = mentions;
    if (project) body.project = project;
    // Question routing is deterministic server-side (no LLM, unlike capture
    // ingestion), so the default 8s budget is plenty — match correct/priority,
    // not add's 30s ingestion timeout. No outbox spool either: the drain replays
    // only /v1/capture bodies, so a failed question fails open like correct does.
    const r = await remote.post(cfg, "/v1/questions", body, { timeoutMs: 8000 });
    if (r.transport) {
      err(`offline — could not reach server (${r.error})`);
      return 1;
    }
    if (!r.ok) {
      // The REST endpoint returns the validator's error list — the detail the MCP
      // tool's opaque "invalid_node" lacked (issue-cc-mcp-ask-question-validation-
      // opacity); surface message + details so a rejected question is fixable
      // without a blind retry (e.g. a malformed --project slug -> 400).
      const e = r.json && r.json.error;
      const detail = e && Array.isArray(e.details) && e.details.length ? ` (${e.details.join("; ")})` : "";
      err(`ask error ${r.status}${e && e.message ? `: ${e.message}` : ""}${detail}`);
      return 1;
    }
    const j = r.json || {};
    out(j.id ? `question filed: ${j.id}` : `question filed (${j.status || "ok"})`);
    out(writeTargetLine(cfg));
    // Report routing so the asker knows who it reached, or that it's unrouted and
    // visible to everyone (no steward matched its neighborhood).
    if (j.routed_to) out(`  routed to ${j.routed_to}${j.via ? ` (via ${j.via})` : ""}`);
    else out(`  unrouted — no steward matched; visible to everyone`);
    for (const w of (j.warnings || [])) err(`  warning: ${w}`);
    return 0;
  }

  // local: hand the user a typed, validated question node file (no router — the
  // node lands open + queueable, surfaced by `spor next` like any other work).
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  const nodesDir = cfg.nodesDir();
  if (!fs.existsSync(nodesDir)) {
    err(`no graph at ${nodesDir} — run 'spor init' first`);
    return 1;
  }
  // Reject a --mention id that wouldn't round-trip through the frontmatter parser
  // before writing, so the mentions edge can't silently vanish on read
  // (issue-spor-local-add-ask-project-normalization-edge-validation).
  const badMention = firstBadEdgeId(mentions.map((m) => ["--mention", m]));
  if (badMention) {
    err(edgeIdErr(badMention));
    return 1;
  }
  // Normalize an explicit --project to the canonical slug the cwd fallback
  // already is (safeSlug -> projectSlug), so `--project My_Repo` stamps `my-repo`
  // instead of a verbatim, non-canonical value the server would have rejected; a
  // flag with no slug characters is a hard error, not a silent empty stamp
  // (issue-spor-local-add-ask-project-normalization-edge-validation).
  if (project && !u.slugify(project)) {
    err(`invalid --project "${project}" — it has no slug characters (expected ^[a-z0-9][a-z0-9-]*$).`);
    return 1;
  }
  const slug = project ? u.slugify(project) : safeSlug();
  const titleText = title || text.split(/\s+/).slice(0, 10).join(" ");
  const summary = text.length > 500 ? text.slice(0, 497) + "..." : text;

  let g;
  try {
    g = graphLib.loadGraph(nodesDir);
  } catch (e) {
    err(`could not load graph: ${e.message}`);
    return 1;
  }
  const prefixes = (g.registry && g.registry.prefixesFor("question")) || null;
  const prefix = prefixes && prefixes[0] ? prefixes[0] : "question-";
  let id = values.id || `${prefix}${kebab(titleText) || today()}`;
  let n = 1;
  let base = id;
  while (fs.existsSync(path.join(nodesDir, `${id}.md`))) id = `${base}-${++n}`;

  // --mention -> a mentions edge (the weakest association, the same edge the
  // server routes off), so the local node carries the same lineage as remote.
  const edgeLines = mentions.map((m) => `  - {type: mentions, to: ${m}}`);
  const edgesBlock = edgeLines.length ? `edges:\n${edgeLines.join("\n")}\n` : "";
  const md = `---\nid: ${id}\ntype: question\nrepo: ${slug}\ntitle: ${titleText.replace(/\n/g, " ")}\nsummary: ${summary.replace(/\n/g, " ")}\nstatus: open\n${edgesBlock}date: ${today()}\n---\n\n${text}\n`;
  let node;
  try {
    node = graphLib.parseFrontmatter(md, `${id}.md`);
  } catch (e) {
    err(`invalid question: ${e.message}`);
    return 1;
  }
  const v = graphLib.validateNode(g, node);
  if (!v.ok) {
    err(`invalid question:\n  ${v.errors.join("\n  ")}`);
    return 1;
  }
  fs.writeFileSync(path.join(nodesDir, `${id}.md`), md);
  out(`question filed: ${id} (open)`);
  out(writeTargetLine(cfg));
  out(`  'spor next' will surface it; answer it with a node carrying an answers edge.`);
  return 0;
}

// --- spor drain ---------------------------------------------------------
// Flush the fail-open capture spool (graphHome/outbox/*) to the team server — the
// manual trigger of the same drain-outbox engine session-start fires detached, so
// a pure-CLI user who never opens a Claude Code session still has a way to ship
// stranded captures (task-spor-cli-outbox-drain-verb). Remote-only: local mode
// never spools (captures write straight to the graph), so there is nothing to
// drain. Setting the active config first makes the engine resolve server/token
// through the SAME tenant cascade the CLI did (file config, --org), not raw env.
async function cmdDrain(cfg, { values }) {
  if (cfg.mode() !== "remote") {
    out("nothing to drain — local mode has no server to ship to (captures write straight to the graph).");
    return 0;
  }
  u.setConfig(cfg);
  const graph = cfg.graphHome();
  const outbox = path.join(graph, "outbox");
  const before = u.spoolStats(outbox);
  const deadBefore = u.spoolStats(path.join(outbox, "dead"));
  if (!before.count) {
    out("outbox empty — nothing to drain.");
    if (deadBefore.count) {
      out(`  ${deadBefore.count} in outbox/dead/ (permanent rejects) — re-mint SPOR_TOKEN, then replay outbox/dead/.`);
    }
    return 0;
  }
  const timeout = Math.max(1, Number(values.timeout) || 30);
  const limit = Math.max(0, Number(values.limit) || 0);
  out(`draining ${before.count} spooled capture${before.count === 1 ? "" : "s"} -> ${u.serverHost()} ...`);
  const { drainOutbox } = require(path.join(ROOT, "scripts", "engines", "drain-outbox.js"));
  const s = await drainOutbox(graph, "manual", timeout, limit);
  const parts = [`drained ${s.drained}/${s.attempted}`];
  if (s.deadLettered) parts.push(`${s.deadLettered} dead-lettered (permanent reject)`);
  if (s.failed) parts.push(`${s.failed} left spooled (server unreachable/transient)`);
  const after = u.spoolStats(outbox);
  if (after.count && !limit) parts.push(`${after.count} remaining`);
  out(parts.join("; ") + ".");
  if (u.spoolStats(path.join(outbox, "dead")).count) {
    out("  some captures are permanently rejected in outbox/dead/ — re-mint SPOR_TOKEN, then replay them.");
  }
  // Exit 1 only when nothing made progress (server unreachable, all left spooled)
  // so a script can detect a no-op drain; a partial/full ship or a dead-letter is
  // progress (exit 0). Mirrors cmdAdd, which also exits 1 on a transport failure.
  return s.drained > 0 || s.deadLettered > 0 ? 0 : 1;
}

// Best-effort opportunistic drain after a successful remote `spor add`: only when
// a spool exists, bounded (5s/file, no retry), and swallowing all errors so it
// never turns the add's success into a failure. Adopts the CLI's resolved cfg as
// the active cascade so the engine ships through the same tenant the add did.
async function opportunisticDrain(cfg) {
  try {
    const graph = cfg.graphHome();
    if (!u.spoolStats(path.join(graph, "outbox")).count) return;
    u.setConfig(cfg);
    const { drainOutbox } = require(path.join(ROOT, "scripts", "engines", "drain-outbox.js"));
    const s = await drainOutbox(graph, "cli-add", 5, 0);
    if (s.drained) out(`  (also flushed ${s.drained} spooled capture${s.drained === 1 ? "" : "s"} from the outbox)`);
  } catch {
    /* the add already succeeded — draining the backlog is a bonus, never a gate */
  }
}

// --- spor correct -------------------------------------------------------
// Record a standing correction to a briefing — the CLI surface for /spor:correct,
// so the skill routes through ONE verb instead of a remote-curl-vs-local-file
// mode branch (task-cc-spor-skills-route-through-cli-drop-mode-prose). Remote:
// POST /v1/corrections (propose_correction's REST twin); the server generates the
// corr-<target>-<n> id, builds + validates + commits the node. Local: write the
// corr node file ourselves and validate. Either way the correction fires at every
// future compile whose scope includes the target (node id | project:<slug> |
// global), per lib/kernel/graph.js correctionInScope.
async function cmdCorrect(cfg, { values, positionals }) {
  const target = positionals[0];
  const guidance = values.guidance != null ? values.guidance : positionals[1];
  if (!target) {
    err('usage: spor correct <target> [guidance] [--pin ID] [--exclude ID] [--title ...]');
    err("  target is a node id, project:<slug>, or global");
    return 1;
  }
  // --pin/--exclude are repeatable (parseArgs multiple: true -> arrays); a lone
  // string is normalized to a one-element list. Empty when neither is given.
  const toList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const pin = toList(values.pin);
  const exclude = toList(values.exclude);
  if (!guidance && !pin.length && !exclude.length) {
    err("a correction needs at least one of: guidance text, --pin, or --exclude");
    return 1;
  }
  const title = values.title || `correction for ${target}`;

  if (cfg.mode() === "remote") {
    const body = { target, pin, exclude, guidance: guidance || "", title };
    const r = await remote.post(cfg, "/v1/corrections", body, { timeoutMs: 8000 });
    if (r.transport) {
      err(`offline — could not reach server (${r.error})`);
      return 1;
    }
    if (!r.ok) {
      err(`correction error ${r.status}`);
      return 1;
    }
    const id = (r.json && r.json.id) || "";
    out(id ? `correction created: ${id}` : `correction created (${(r.json && r.json.status) || "ok"})`);
    out(writeTargetLine(cfg));
    const warnings = (r.json && r.json.warnings) || [];
    for (const w of warnings) err(`  warning: ${w}`);
    return 0;
  }

  // local: write corr-<target>-<n>.md and validate
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  const nodesDir = cfg.nodesDir();
  if (!fs.existsSync(nodesDir)) {
    err(`no graph at ${nodesDir} — run 'spor init' first`);
    return 1;
  }
  // The target carries a ':' for project: scope, which is not a legal id char —
  // kebab it into the id stem (project:spor -> project-spor, global -> global).
  const stem = kebab(target) || "x";
  let n = 1;
  let id = `corr-${stem}-${n}`;
  while (fs.existsSync(path.join(nodesDir, `${id}.md`))) id = `corr-${stem}-${++n}`;
  const listInline = (a) => `[${a.join(", ")}]`;
  // Every node needs a standalone summary (validateNode); use the guidance, else
  // the title. One line, capped well under the frontmatter's comfort zone.
  const summary = (guidance || title).replace(/\n/g, " ").slice(0, 200);
  const md =
    `---\nid: ${id}\ntype: correction\ntitle: ${title.replace(/\n/g, " ")}\n` +
    `summary: ${summary}\ntarget: ${target}\npin: ${listInline(pin)}\nexclude: ${listInline(exclude)}\n` +
    `date: ${today()}\n---\n\n${guidance || ""}\n`;
  let node;
  try {
    node = graphLib.parseFrontmatter(md, `${id}.md`);
  } catch (e) {
    err(`invalid correction: ${e.message}`);
    return 1;
  }
  let g;
  try {
    g = graphLib.loadGraph(nodesDir);
  } catch (e) {
    err(`could not load graph: ${e.message}`);
    return 1;
  }
  const v = graphLib.validateNode(g, node);
  if (!v.ok) {
    err(`invalid correction:\n  ${v.errors.join("\n  ")}`);
    return 1;
  }
  // pin/exclude must name existing nodes (mirror the server's id-only rule).
  const missing = [...pin, ...exclude].filter((x) => !fs.existsSync(path.join(nodesDir, `${x}.md`)));
  for (const m of missing) err(`  warning: pinned/excluded node '${m}' does not exist yet — create it for the correction to take effect`);
  fs.writeFileSync(path.join(nodesDir, `${id}.md`), md);
  out(`correction created: ${id} (targets ${target})`);
  out(writeTargetLine(cfg));
  return 0;
}

// --- spor priority ------------------------------------------------------
// The CLI wrapper for the set_priority micro-mutation (task-spor-cli-priority-
// verb): a thin, mode-aware client of the route the REST POST /v1/nodes/{id}/
// priority and the MCP set_priority tool already expose, so the shell stops
// being the one surface where setting a node's priority means a raw curl. The
// human-override half of the queue blend (dec-cc-opinionated-queue-blend) gets
// a verb to match add/correct.
//
// The p1/p2/p3 + clearing vocabulary is the server's (set_priority in
// spor-server's rest.js); it is NOT in the schema registry, so it is mirrored
// here for a fast client-side reject and an identical local-mode write. The
// canonical value ("" clears, else p1|p2|p3) is what we send/write, so both
// modes behave the same on `none`/`clear`/`p0`/`""`.
const PRIORITY_VALUES = new Set(["p1", "p2", "p3"]);
const PRIORITY_CLEAR = new Set(["", "none", "null", "clear", "0", "p0"]);
function normalizePriority(raw) {
  const want = raw == null ? "" : String(raw).trim().toLowerCase();
  if (PRIORITY_CLEAR.has(want)) return { ok: true, value: "" };
  if (PRIORITY_VALUES.has(want)) return { ok: true, value: want };
  return { ok: false };
}

// Read `git config user.name`/`user.email` from the graph home for the local
// `priority_by` stamp — the local analogue of the server stamping it from the
// authenticated token (dec-viewer-token-binding). Best-effort: either piece may
// be empty, in which case the stamp is omitted (the server omits priority_by
// when it has no identity too). Mirrors lib/queue.js's gitIdentityEmail read.
function gitIdentity(repoDir) {
  const read = (key) => {
    const r = gitSpawn(repoDir, ["config", key], { stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 ? (r.stdout || "").trim() : "";
  };
  return { name: read("user.name"), email: read("user.email") };
}

// Rewrite a node's raw markdown to carry `value` for `field` (or clear it
// when value is ""), stamping `<field>_by/_at/_via`. Byte-mirrors the
// server's rewrite<Field> so a local node and a remote one read the same
// after the mutation; returns the new raw, or null when the frontmatter
// can't be located. Shared by `spor priority` and `spor ready`
// (task-spor-priority-readiness-stamp-helper-dedup) — the only per-field
// pieces are the field name itself, the allowed-value vocabulary (each
// verb's own normalize*), and the provenance key prefix this derives from it.
function rewriteStamp(field, raw, value, identity, via) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  let fm = m[1];
  const body = m[2];
  const stripFmLine = (s, key) => s.replace(new RegExp(`(^|\\n)${key}:[^\\n]*`, "g"), "");
  for (const k of [field, `${field}_by`, `${field}_at`, `${field}_via`]) fm = stripFmLine(fm, k);
  fm = fm.replace(/\n+$/, "").replace(/^\n+/, "");
  const stamps = [];
  if (value) {
    stamps.push(`${field}: ${value}`);
    if (identity && identity.name && identity.email) stamps.push(`${field}_by: ${identity.name} <${identity.email}>`);
    stamps.push(`${field}_at: ${u.isoMs()}`);
    stamps.push(`${field}_via: ${via}`);
  }
  const fmOut = stamps.length ? `${fm}\n${stamps.join("\n")}` : fm;
  return `---\n${fmOut}\n---\n${body}`;
}

// The set-a-stamp-field verb core: validate/normalize is caller-specific
// (each verb has its own allowed-value vocabulary and argument shape), but
// once a canonical `value` is in hand, `priority` and `ready` share the
// identical scaffolding this factors out — remote POSTs the micro-mutation
// route ({[field]: value} to /v1/nodes/{id}/{field}); local mode does
// get -> rewrite frontmatter -> validate -> write, mirroring the server's
// read-modify-write (no server to POST to). Identity is the git user the way
// local $viewer is derived (lib/queue.js viewerFor), the door is `cli`.
async function stampField(cfg, { id, field, value }) {
  if (cfg.mode() === "remote") {
    // Send the canonical value the server validates again; it stamps
    // <field>_by/_at/_via (via: rest) from the token.
    const r = await remote.post(cfg, `/v1/nodes/${encodeURIComponent(id)}/${field}`, { [field]: value }, { timeoutMs: 8000 });
    if (r.transport) {
      err(`offline — could not reach server (${r.error})`);
      return 1;
    }
    if (r.status === 404) {
      err(`no such node: ${id}`);
      return 1;
    }
    if (!r.ok) {
      const msg = r.json && r.json.error && r.json.error.message;
      err(`${field} error ${r.status}${msg ? `: ${msg}` : ""}`);
      return 1;
    }
    out(value ? `${field} set: ${id} -> ${value}` : `${field} cleared: ${id}`);
    out(writeTargetLine(cfg));
    return 0;
  }

  const nodesDir = cfg.nodesDir();
  const file = path.join(nodesDir, `${id}.md`);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    err(`no such node: ${id}`);
    return 1;
  }
  const identity = gitIdentity(path.dirname(nodesDir));
  const newRaw = rewriteStamp(field, raw, value, identity, "cli");
  if (newRaw == null) {
    err(`could not locate frontmatter in ${id}`);
    return 1;
  }
  // validate before writing (same bar as add/correct), so a malformed result
  // never lands on disk.
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  let g;
  try {
    g = graphLib.loadGraph(nodesDir);
  } catch (e) {
    err(`could not load graph: ${e.message}`);
    return 1;
  }
  let node;
  try {
    node = graphLib.parseFrontmatter(newRaw, `${id}.md`);
  } catch (e) {
    err(`invalid node after ${field} rewrite: ${e.message}`);
    return 1;
  }
  const v = graphLib.validateNode(g, node);
  if (!v.ok) {
    err(`invalid node after ${field} rewrite:\n  ${v.errors.join("\n  ")}`);
    return 1;
  }
  fs.writeFileSync(file, newRaw);
  out(value ? `${field} set: ${id} -> ${value}` : `${field} cleared: ${id}`);
  out(writeTargetLine(cfg));
  return 0;
}

async function cmdPriority(cfg, { positionals }) {
  const id = positionals[0];
  const rawPriority = positionals[1];
  if (!id || rawPriority == null) {
    err("usage: spor priority <id> <p1|p2|p3|clear>");
    err("  set the human-triage priority of a queue item, or clear it (none/clear)");
    return 1;
  }
  const norm = normalizePriority(rawPriority);
  if (!norm.ok) {
    err(`priority '${rawPriority}' not allowed — use p1, p2, p3, or none/clear to remove it`);
    return 1;
  }
  return stampField(cfg, { id, field: "priority", value: norm.value });
}

// --- spor ready ----------------------------------------------------------
// The CLI wrapper for the agent-readiness manual override (task-spor-readiness-
// stamp-verb, slice 2 of dec-spor-agent-readiness-derived-classification): a
// verbatim sibling of `spor priority` above — writes readiness:/readiness_by:/
// _at:/_via: frontmatter with provenance, the ONE hand-set piece of the
// otherwise-derived classification lib/kernel/queue.js's deriveReadiness
// computes in the rankQueue render pass. `spor ready <id>` stamps `readiness:
// agent` (agent-ready — rankQueue/show_queue class it agent and offer
// suggest:dispatch); `--needs-input` clears the stamp — a manual demotion back
// OFF agent-ready to whatever the structural derivation produces (human, if a
// requires:human/assigned-person/held/open-question signal already applies;
// untriaged otherwise — there is no hand-settable `readiness: human` value,
// since human is derived structurally and a make-ready pass gates hard gaps
// with explicit `blocks` edges instead, per the decision node). The stamp is an
// OVERRIDE, not a status: deriveReadiness checks the human conditions BEFORE
// the readiness:agent stamp, so a later open question or requires:human edit
// still wins and flips a stamped item back to human.

async function cmdReady(cfg, { values, positionals }) {
  const id = positionals[0];
  if (!id) {
    err("usage: spor ready <id> [--needs-input]");
    err("  stamp a queue item agent-ready, or demote it back to derived with --needs-input");
    return 1;
  }
  const value = values["needs-input"] ? "" : "agent";
  return stampField(cfg, { id, field: "readiness", value });
}

// --- spor set-status / spor edge ----------------------------------------
// The CLI wrappers for the set_status (POST /v1/nodes/{id}/status) and add_edge
// (POST /v1/nodes/{id}/edges) micro-mutations (task-spor-set-status-edge-cli-
// verbs): the precise-write counterparts to the prose-only `spor add` capture, so
// a shell user flips a node's status — which CLAIMS it on an active status
// (dec-cc-task-claim-lease) — or closes a loop with an edge, without dropping to
// raw curl. Both have REST + MCP twins (set_status / add_edge) but lacked a verb.
//
// Mode-aware like `priority`: remote mode POSTs the micro-mutation route (the
// server runs the transitions() gate, normalizes the edge, and claims on an
// active status); local mode does the read-modify-write itself against the node
// file, mirroring the server's forceStatus / insertEdgeLine so a local node reads
// the same after the mutation. Local mode has no lease (dec-cc-task-claim-lease
// "Local mode": no pool or contention), so an active status sets the field
// without a claim — symmetric with local dispatch skipping the claim.
const NODE_ID_RE = /^[a-z0-9][a-z0-9-]*$/; // mirrors the server's ID_RE/SLUG_RE

// The one id-length invariant (issue-spor-server-node-id-length-unbounded):
// NODE_ID_RE is shape-only and imposes no cap, mirroring the server's
// unbounded ID_RE/SLUG_RE. The server enforces MAX_ID_LENGTH (200,
// server/store-validate.ts) at CREATE for every remote write; local mode
// writes node files directly, bypassing the server entirely, so it needs
// the same cap on its own CREATE path to keep a personal graph under the
// invariant remote graphs already hold. Enforced create-only — a node
// written before this cap existed must keep reading/routing past it.
//
// Scope, precisely: cmdPutNode is the door this guards. Several other local
// doors still mint node files with unbounded ids — among them `spor add`/
// `spor ask` (values.id or a kebab of the title), `spor agent` and `spor
// person create` (prefix + kebab of the label), and `spor correct` (a kebab
// of the target id) — so the local invariant is not yet complete; remote
// mode is, since the server gate sits under all of them.
const MAX_ID_LENGTH = 200;

// Rewrite a node's raw markdown to carry `value` as its status, mirroring the
// server's forceStatus (store.js): strip any existing status line, then append
// `status: <value>` at the end of the frontmatter block. Returns the new raw, or
// null when the frontmatter can't be located.
function rewriteStatus(raw, value) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  let fm = m[1];
  const body = m[2];
  fm = fm.replace(/(^|\n)status:[^\n]*/g, "").replace(/\n+$/, "").replace(/^\n+/, "");
  return `---\n${fm}\nstatus: ${value}\n---\n${body}`;
}

// --- resolve-time ancestry warning (task-spor-client-resolve-time-ancestry-
// gate) --------------------------------------------------------------------
// The client-side twin of dec-spor-merge-verification-lands-server-side-as-a-
// gardener-check's set_status warning: that warning is a no-op wherever the
// SERVER has no checkout mapped (SPOR_REPOS empty — the hosted tenant every
// fleet agent's `spor set-status` writes to), but the CLIENT is always
// running from inside a checkout. Same warn-never-block, third-state-oracle
// posture, scoped down to just this node's own `commits:` stamps (no
// resolver fan-out — the server sweep already covers that ground) and the
// `dispatch.repos` map (the client's SPOR_REPOS) instead of a server-side
// checkout.
//
// This exact 4-value set — not the broader registry terminal-status union
// resolution.js's terminalStatuses() computes — is deliberate, mirroring the
// server's lib-engine/kernel/merge-verify.js COMPLETION_STATUSES byte for
// byte: a merge claim is only implied by done/resolved/completed/merged.
// rejected/abandoned are absent because dropped work has no obligation to
// have landed anywhere; a type-scoped completion word like decision's
// `settled` or artifact's `released` is deliberately NOT a merge claim
// either — same reasoning, kept in lockstep with the server twin rather than
// independently derived from the registry.
const ANCESTRY_COMPLETION_STATUSES = new Set(["done", "resolved", "completed", "merged"]);
const ANCESTRY_TRUNK_REFS = ["main", "master", "origin/main", "origin/master"];

// `git -C <dir> <args>` -> ok (exit 0) | not-ok (any other exit, a spawn
// failure, or the timeout firing) — never throws.
function gitProbeOk(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 5000 });
  return !r.error && r.status === 0;
}

// isLandedLocally(dir, sha) -> {known, landed} — the same third state as the
// server's makeAncestryOracle: known:false means unverifiable (sha absent
// from the checkout, no trunk ref resolves, or git errored) and must never
// be read as "unlanded"; only known:true, landed:false is evidence-backed.
function isLandedLocally(dir, sha) {
  if (!gitProbeOk(dir, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`])) return { known: false, landed: null };
  const trunks = ANCESTRY_TRUNK_REFS.filter((ref) => gitProbeOk(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]));
  if (!trunks.length) return { known: false, landed: null };
  const answered = [];
  for (const ref of trunks) {
    const r = spawnSync("git", ["-C", dir, "merge-base", "--is-ancestor", sha, ref], { encoding: "utf8", timeout: 5000 });
    if (!r.error && r.status === 0) return { known: true, landed: true };
    if (!r.error && r.status === 1) { answered.push(ref); continue; }
    return { known: false, landed: null }; // an errored trunk could be the one that says yes
  }
  return { known: true, landed: false };
}

// resolveAncestryWarning(cfg, id, status, commits) -> string|null. Advisory
// only, silent (never an error) on anything unverifiable: a non-completion
// status, no commits: stamps, a malformed stamp, an unmapped repo, or an
// unreadable checkout. Only a definitive "known and not landed" ever warns.
function resolveAncestryWarning(cfg, id, status, commits) {
  if (!ANCESTRY_COMPLETION_STATUSES.has(String(status || "").trim().toLowerCase())) return null;
  const stamps = Array.isArray(commits) ? commits : [];
  if (!stamps.length) return null;
  const unlanded = [];
  for (const stamp of stamps) {
    const s = String(stamp);
    const at = s.indexOf("@");
    if (at <= 0 || at === s.length - 1) continue; // malformed repo@sha — silent
    const dir = repoDirForSlug(cfg, s.slice(0, at));
    if (!dir) continue; // repo not in dispatch.repos — silent
    const v = isLandedLocally(dir, s.slice(at + 1));
    if (v.known && v.landed === false) unlanded.push(s);
  }
  if (!unlanded.length) return null;
  const plural = unlanded.length === 1 ? "" : "s";
  return `${id} is now ${status}, but ${unlanded.length} commit${plural} it rests on ` +
    `(${unlanded.join(", ")}) ${unlanded.length === 1 ? "is" : "are"} on no trunk branch in the ` +
    `local checkout — the work may still be on an unmerged branch.`;
}

// Fetch the commits: stamps for `id` for a REMOTE ancestry check. The status
// POST response carries no node body (API.md: {status, id, revision,
// warnings}), so this is one extra GET — paid only for a completion status,
// never for the common in-progress/active case. Fails silently to []: an
// unreachable server or unparseable body must not turn an advisory check
// into a broken status write.
async function fetchCommitsForAncestryCheck(cfg, id) {
  try {
    const r = await remote.get(cfg, `/v1/nodes/${encodeURIComponent(id)}`, { timeoutMs: 5000 });
    if (r.transport || !r.ok) return [];
    const raw = r.json && r.json.raw;
    if (typeof raw !== "string") return [];
    const graphLib = require(path.join(ROOT, "lib", "graph.js"));
    const node = graphLib.parseFrontmatter(raw, `${id}.md`);
    return Array.isArray(node.commits) ? node.commits : [];
  } catch {
    return [];
  }
}

async function cmdSetStatus(cfg, { positionals }) {
  const id = positionals[0];
  const rawStatus = positionals[1];
  if (!id || rawStatus == null || String(rawStatus).trim() === "") {
    err("usage: spor set-status <id> <status>");
    err("  set a node's status; an active status (e.g. active/open/in-progress) also claims it");
    return 1;
  }
  const value = String(rawStatus).trim();

  if (cfg.mode() === "remote") {
    // The server validates the status against the type's enum + transitions()
    // gate and, on an active-category status, claims the node (creates/refreshes
    // the lease) — the response carries the lease so the user learns the outcome.
    const r = await remote.post(cfg, `/v1/nodes/${encodeURIComponent(id)}/status`, { status: value }, { timeoutMs: 8000 });
    if (r.transport) {
      err(`offline — could not reach server (${r.error})`);
      return 1;
    }
    if (r.status === 404) {
      err(`no such node: ${id}`);
      return 1;
    }
    if (!r.ok) {
      const e = (r.json && r.json.error) || {};
      err(`set-status error ${r.status}${e.message ? `: ${e.message}` : ""}`);
      if (Array.isArray(e.details)) for (const d of e.details) err(`  ${d}`);
      return 1;
    }
    out(`status set: ${id} -> ${value}`);
    out(writeTargetLine(cfg));
    const lease = r.json && r.json.lease;
    if (lease) {
      if (lease.error) err(`  note: not claimed (${lease.error}${lease.holder ? `, held by ${lease.holder}` : ""})`);
      else out(`  claimed${lease.expires_at ? ` (lease expires ${lease.expires_at})` : ""}`);
    }
    const warnings = (r.json && r.json.warnings) || [];
    for (const w of warnings) err(`  warning: ${w}`);
    if (ANCESTRY_COMPLETION_STATUSES.has(value.toLowerCase())) {
      try {
        const commits = await fetchCommitsForAncestryCheck(cfg, id);
        const warning = resolveAncestryWarning(cfg, id, value, commits);
        if (warning) err(`  warning: ${warning}`);
      } catch {
        // advisory only — a git/network hiccup must not fail a status write that already landed
      }
    }
    return 0;
  }

  // local: the shared write body below, then this command's own reporting.
  const wrote = setStatusLocal(cfg, id, value);
  if (!wrote.ok) {
    err(wrote.reason);
    return 1;
  }
  out(`status set: ${id} -> ${value}`);
  out(writeTargetLine(cfg));
  try {
    const warning = resolveAncestryWarning(cfg, id, value, wrote.node.commits);
    if (warning) err(`  warning: ${warning}`);
  } catch {
    // advisory only — a git hiccup must not fail a status write that already landed
  }
  return 0;
}

// The LOCAL status write, shared by `spor set-status` and the gate pipeline's
// demotion (gateWriteStatus) so the validated door exists once: rewrite the
// node file's status frontmatter in place, mirroring the server's
// read-modify-write (no server to POST to, no lease to take). When the type's
// schema declares a status enum, reject an out-of-vocabulary value the same way
// the server's setStatus does (registry is the contract, via
// `statusVocabulary`); types whose vocabulary lives in a sandbox validate() fn
// aren't enum-checked here, exactly as the server's membership check skips them.
//
// Returns {ok, node} or {ok: false, reason} — reporting belongs to the caller,
// since one of them is a CLI command and the other is a fail-soft step inside a
// worker loop. `graph` lets a caller that already loaded one pass it in.
function setStatusLocal(cfg, id, value, { graph = null } = {}) {
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  const nodesDir = cfg.nodesDir();
  const file = path.join(nodesDir, `${id}.md`);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, reason: `no such node: ${id}` };
  }
  let g = graph;
  if (!g) {
    try {
      g = graphLib.loadGraph(nodesDir);
    } catch (e) {
      return { ok: false, reason: `could not load graph: ${e.message}` };
    }
  }
  const type = g.nodes[id] && g.nodes[id].type;
  // The status enum lives in TWO declaration sites and a type may use either:
  // the declarative completion policy's `status.vocabulary` (task, issue,
  // question — what `registry.statusVocabulary` reads) and the older
  // `fields.status.enum` (workflow, workflow-run — which declare ONLY that).
  // Reading one alone silently disarms the check for every type that uses the
  // other, so take the UNION. Membership stays a VERBATIM compare, as it always
  // was: every declared value is lowercase, so `DONE` is refused rather than
  // passing the check and then being written through unchanged.
  const allowed = new Set();
  const schema = type && g.registry.nodeSchemas ? g.registry.nodeSchemas.get(type) : null;
  const fieldEnum = schema && schema.payload && schema.payload.fields && schema.payload.fields.status && schema.payload.fields.status.enum;
  if (Array.isArray(fieldEnum)) for (const s of fieldEnum) allowed.add(s);
  if (type) for (const s of g.registry.statusVocabulary(type)) allowed.add(s);
  if (allowed.size && !allowed.has(String(value))) {
    return { ok: false, reason: `status '${value}' not allowed for type '${type}' — allowed: ${[...allowed].join(", ")}` };
  }
  const newRaw = rewriteStatus(raw, value);
  if (newRaw == null) return { ok: false, reason: `could not locate frontmatter in ${id}` };
  let node;
  try {
    node = graphLib.parseFrontmatter(newRaw, `${id}.md`);
  } catch (e) {
    return { ok: false, reason: `invalid node after status rewrite: ${e.message}` };
  }
  const v = graphLib.validateNode(g, node);
  if (!v.ok) return { ok: false, reason: `invalid node after status rewrite:\n  ${v.errors.join("\n  ")}` };
  fs.writeFileSync(file, newRaw);
  return { ok: true, node };
}

// Validate + normalize `--attr key=value` pairs to a flat {k: String(v)} map (or
// null when none), mirroring the server's normalizeEdgeAttrs: only [\w-] tokens
// round-trip through the frontmatter edge grammar, type/to are structural (not
// attributes), and empty values are dropped.
function parseEdgeAttrs(rawList) {
  const list = rawList == null ? [] : Array.isArray(rawList) ? rawList : [rawList];
  if (!list.length) return { attrs: null };
  const out = {};
  for (const item of list) {
    const s = String(item);
    const idx = s.indexOf("=");
    if (idx < 1) return { error: `--attr must be key=value (got '${item}')` };
    const k = s.slice(0, idx).trim();
    const val = s.slice(idx + 1).trim();
    if (k === "type" || k === "to") return { error: `edge attribute '${k}' is reserved — it names the edge's structure, not an override` };
    if (!/^[\w-]+$/.test(k)) return { error: `edge attribute key '${k}' must be [A-Za-z0-9_-]` };
    if (val === "") continue;
    if (!/^[\w-]+$/.test(val)) return { error: `edge attribute value '${val}' must be [A-Za-z0-9_-] (the frontmatter edge grammar)` };
    out[k] = val;
  }
  return { attrs: Object.keys(out).length ? out : null };
}

// Render an attribute map to the `, k: v` tail insertEdgeLine appends, byte-
// matching the server's renderEdgeAttrs (sorted keys, blanks dropped).
function renderEdgeAttrsTail(attrs) {
  if (!attrs) return "";
  return Object.keys(attrs)
    .filter((k) => attrs[k] != null && attrs[k] !== "")
    .sort()
    .map((k) => `, ${k}: ${attrs[k]}`)
    .join("");
}

// Append a `  - {type: T, to: TO[, k: v]}` line to a node's frontmatter, mirroring
// the server's insertEdgeLine: insert after the last existing edge (or after the
// `edges:` key), creating the block at the end of the frontmatter when absent.
// Returns the new raw, or null when the frontmatter can't be located.
function appendEdgeLine(raw, type, to, attrs) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const body = m[2];
  const line = `  - {type: ${type}, to: ${to}${renderEdgeAttrsTail(attrs)}}`;
  const lines = m[1].split("\n");
  const EDGE_LINE = /^\s*-\s*\{type:/;
  let edgesKey = -1, lastEdge = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^edges:\s*$/.test(lines[i])) edgesKey = i;
    if (EDGE_LINE.test(lines[i])) lastEdge = i;
  }
  if (edgesKey === -1) lines.push("edges:", line);
  else lines.splice((lastEdge > edgesKey ? lastEdge : edgesKey) + 1, 0, line);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

async function cmdEdge(cfg, { values, positionals }) {
  const id = positionals[0];
  const type = positionals[1];
  const to = positionals[2];
  if (!id || !type || !to) {
    err("usage: spor edge <id> <type> <to> [--attr key=value]");
    err("  add a typed edge from <id> to <to> (e.g. blocks, resolves, relates-to)");
    return 1;
  }
  const attrsRes = parseEdgeAttrs(values.attr);
  if (attrsRes.error) {
    err(attrsRes.error);
    return 1;
  }
  const attrs = attrsRes.attrs;

  if (cfg.mode() === "remote") {
    const body = { type, to };
    if (attrs) body.attrs = attrs;
    const r = await remote.post(cfg, `/v1/nodes/${encodeURIComponent(id)}/edges`, body, { timeoutMs: 8000 });
    if (r.transport) {
      err(`offline — could not reach server (${r.error})`);
      return 1;
    }
    if (!r.ok) {
      const e = (r.json && r.json.error) || {};
      err(`edge error ${r.status}${e.message ? `: ${e.message}` : ""}`);
      if (Array.isArray(e.details)) for (const d of e.details) err(`  ${d}`);
      return 1;
    }
    // The server echoes the node actually modified — an inverse form flips the
    // canonical edge onto the target, so r.id may differ from the id we passed.
    const echoed = (r.json && r.json.id) || id;
    const skipped = r.json && r.json.status === "skipped";
    out(skipped
      ? `edge already present: ${id} -[${type}]-> ${to}`
      : `edge added: ${id} -[${type}]-> ${to}${echoed !== id ? ` (stored on ${echoed})` : ""}`);
    out(writeTargetLine(cfg));
    return 0;
  }

  // local: normalize + validate + append, mirroring store.addEdge — an inverse
  // form puts the canonical edge on the OTHER node (swap src/target), a rename
  // canonicalizes, the edge type must be known, both ids well-formed, the source
  // must exist, and the target must exist (add_edge never creates a dangling
  // edge). Edge-type tables come from the registry, never a hardcoded list.
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  const nodesDir = cfg.nodesDir();
  let g;
  try {
    g = graphLib.loadGraph(nodesDir);
  } catch (e) {
    err(`could not load graph: ${e.message}`);
    return 1;
  }
  const reg = g.registry;
  let srcId = id, edgeType = type, target = to;
  const inverses = reg.edgeInverses();
  const renames = reg.edgeRenames();
  if (inverses[edgeType]) {
    edgeType = inverses[edgeType];
    const t = srcId; srcId = target; target = t;
  } else if (renames[edgeType]) {
    edgeType = renames[edgeType];
  }
  if (!NODE_ID_RE.test(srcId) || !NODE_ID_RE.test(target)) {
    err(`bad node id ('${srcId}' / '${target}')`);
    return 1;
  }
  if (!reg.isKnownEdge(edgeType)) {
    err(`unknown edge type '${type}'`);
    err(`  known edge types: ${[...reg.knownEdgeTypes()].sort().join(", ")}`);
    return 1;
  }
  const file = path.join(nodesDir, `${srcId}.md`);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    err(`no such node: ${srcId}`);
    return 1;
  }
  if (!g.nodes[target]) {
    err(`edge target '${target}' does not exist — create it first (add_edge never creates dangling edges)`);
    return 1;
  }
  const existing = (g.nodes[srcId] && g.nodes[srcId].edges) || [];
  if (existing.some((e) => e.type === edgeType && e.to === target) && !attrs) {
    out(`edge already present: ${id} -[${type}]-> ${to}`);
    out(writeTargetLine(cfg));
    return 0;
  }
  const newRaw = appendEdgeLine(raw, edgeType, target, attrs);
  if (newRaw == null) {
    err(`could not locate frontmatter in ${srcId}`);
    return 1;
  }
  let node;
  try {
    node = graphLib.parseFrontmatter(newRaw, `${srcId}.md`);
  } catch (e) {
    err(`invalid node after edge add: ${e.message}`);
    return 1;
  }
  const v = graphLib.validateNode(g, node);
  if (!v.ok) {
    err(`invalid node after edge add:\n  ${v.errors.join("\n  ")}`);
    return 1;
  }
  fs.writeFileSync(file, newRaw);
  out(`edge added: ${id} -[${type}]-> ${to}${srcId !== id ? ` (stored on ${srcId})` : ""}`);
  out(writeTargetLine(cfg));
  return 0;
}

// --- spor claim / renew / extend / release ------------------------------
// The shell front-door for the heartbeat-renewed task lease (dec-cc-task-claim-
// lease, task-spor-claim-lease-cli-verbs): the CLI twins of the claim / renew /
// extend / release MCP tools and the POST /v1/nodes/{id}/{action} REST routes the
// server already exposes (art-res-task-cc-claim-lease-server). Until now only
// `spor dispatch` claimed — internally, at launch — so a person working in a
// terminal had no way to manually take a task, heartbeat it, hand it back, or
// extend it before a long idle gap. These four verbs close that gap.
//
// REMOTE-ONLY by construction: a claim is a server-held lease and local mode has
// no claim pool or contention (dec-cc-task-claim-lease "Local mode"), so — like
// lens/run/whoami — local mode degrades with one clear line and no crash rather
// than faking a lease there. The holder ($viewer) is always the authenticated
// token, never an argument; the server takes/refreshes/retires the lease and
// echoes it, and a conflict (a live lease held by someone else, or a
// lapsed/stolen one) comes back 409 naming the current holder + expiry.

// Parse a human duration (`2h`, `45m`, `30s`, `1d`, or a bare integer of ms) to
// milliseconds, mirroring the server's eligibility.parseDuration so `spor extend`
// and the graph-resident claim_ttl policy speak the same dialect. Returns null on
// a malformed or non-positive value.
const _DURATION_UNIT_MS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
function parseDurationMs(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 0 ? n : null;
  }
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  // A sub-millisecond fraction (e.g. 0.4ms) rounds to 0 — treat that as invalid
  // too, so a non-positive duration is always rejected client-side rather than
  // POSTing {ms:0} for the server to reject.
  const ms = Math.round(n * _DURATION_UNIT_MS[m[2]]);
  return ms > 0 ? ms : null;
}

// One concise line describing a lease (the server's leaseView): expiry, plus the
// holder when the server names one (always you on a happy-path claim/renew/extend
// — confirming which identity your token bound to).
function leaseLine(lease) {
  if (!lease) return "";
  const parts = [];
  if (lease.expires_at) parts.push(`expires ${lease.expires_at}`);
  if (lease.by) parts.push(`held by ${labelledPerson(lease.by_name, lease.by)}`);
  return parts.join(", ");
}

const _LEASE_PAST = { claim: "claimed", renew: "renewed", extend: "extended", release: "released" };

async function cmdLease(cfg, action, { positionals }) {
  const id = positionals[0];
  if (!id) {
    err(`usage: spor ${action} <node-id>${action === "extend" ? " <duration>" : ""}`);
    if (action === "extend") err("  duration: 2h / 45m / 30s / 1d (or bare milliseconds)");
    return 1;
  }

  // Remote-only: local mode has no lease pool, so degrade with one clear line
  // (like lens/run) rather than faking a claim that means nothing locally.
  if (cfg.mode() !== "remote") {
    out(`task claims are a team-graph feature — local mode has no lease pool (dec-cc-task-claim-lease).`);
    out(`  set SPOR_SERVER/SPOR_TOKEN (see 'spor join') to claim, renew, extend, or release.`);
    return 0;
  }

  // extend carries the requested duration; parse it client-side so a malformed
  // value never reaches the server (the server takes raw `ms`, bounded by the
  // tenant's claim_ttl_max policy).
  const body = {};
  if (action === "extend") {
    const ms = parseDurationMs(positionals[1]);
    if (ms == null) {
      err(positionals[1] == null
        ? "usage: spor extend <node-id> <duration>  (e.g. 2h, 45m, 30s)"
        : `bad duration '${positionals[1]}' — use 2h / 45m / 30s / 1d or bare milliseconds`);
      return 1;
    }
    body.ms = ms;
  }

  const r = await remote.post(cfg, `/v1/nodes/${encodeURIComponent(id)}/${action}`, body, { timeoutMs: 8000 });
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (r.status === 404) {
    err(`no such node: ${id}`);
    return 1;
  }
  if (r.status === 409) {
    // already_claimed / lease_lost — the server's message already names the
    // current holder + expiry, so surface it verbatim.
    const e = (r.json && r.json.error) || {};
    err(`cannot ${action} ${id}: ${e.message || "lease conflict"}`);
    return 1;
  }
  if (!r.ok) {
    const e = (r.json && r.json.error) || {};
    err(`${action} error ${r.status}${e.message ? `: ${e.message}` : ""}`);
    if (Array.isArray(e.details)) for (const d of e.details) err(`  ${d}`);
    return 1;
  }

  out(`${_LEASE_PAST[action]} ${id}`);
  if (action === "release") {
    // release dropped the lease (no lease echoed); note when it also retired a
    // durable assigned edge (a no-op cleanup reads as "skipped").
    if (r.json && r.json.edge && r.json.edge !== "skipped") out(`  assigned edge retired`);
  } else {
    const line = leaseLine(r.json && r.json.lease);
    if (line) out(`  lease ${line}`);
    if (action === "extend" && r.json && r.json.capped_to_max) out(`  (capped to the org maximum)`);
  }
  return 0;
}

// Persist server/token into the USER config (never a committable repo config).
// Shared by 'join' and the 'install --server/--token' configure step. Only the
// keys given are touched, so a token-only update keeps the existing server.
function writeServerToken(home, server, token) {
  const cfgFile = path.join(home, "config.json");
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(cfgFile, "utf8")) || {};
  } catch {
    /* absent or malformed — start fresh */
  }
  if (server) data.server = server.replace(/\/+$/, "");
  if (token) data.token = token;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify(data, null, 2) + "\n");
  return cfgFile;
}

// A positional that looks like an auth token, not a server URL — the prefixes
// the server mints (spor_pat_…, legacy sub_pat_…). Lets `spor join <token>`
// onboard to the hosted default in one step without mistaking the token for the
// server URL. Case-insensitive and tolerant of surrounding whitespace.
function looksLikeToken(s) {
  return /^(spor|sub)_pat_/i.test((s || "").trim());
}

// ===========================================================================
// spor auth — the CLI auth surface (dec-spor-cli-auth-device-grant-front-door,
// dec-spor-client-cli-mode-tenant-resolution, task-cc-spor-auth-cli-verbs-device-
// code). Multi-tenant: tokens are org-scoped, so a person in N orgs holds N
// credentials in the credential store (lib/auth.js). The `auth` verbs populate
// and select within that store and NEVER clobber a sibling tenant. The flat
// whoami/login/join verbs are aliases (rename-compat, dec-cc-spor-rename-compat-
// dual-read); `join` now APPENDS rather than overwriting.
// ===========================================================================

// Identity probe against a SPECIFIC server+token (the one being joined), which
// may differ from the active tenant — so it can't go through remote.get(cfg).
async function fetchMe(server, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(auth.normServer(server) + "/v1/me", {
      headers: { Authorization: `Bearer ${token || ""}` },
      signal: ctrl.signal,
    });
    const j = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json: j };
  } catch (e) {
    return { ok: false, transport: true, error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// Render a server error message from either shape: an RFC-style oauth error
// ({error:"code", error_description:"..."}) or the generic REST error object
// ({error:{code, message}}). Avoids "[object Object]" in CLI output.
function oauthErrMsg(j) {
  if (!j) return "";
  const e = j.error;
  if (typeof e === "string") return j.error_description ? `${e}: ${j.error_description}` : e;
  if (e && typeof e === "object") return e.message || e.code || "";
  return j.message || "";
}

// One-line token health for `auth list`/`whoami --all`.
function tokenHealth(t) {
  if (!t || !t.access_token) return "no token";
  if (t.exp) {
    const now = Math.floor(Date.now() / 1000);
    if (t.exp <= now) return t.refresh_token ? "expired (auto-refresh)" : "EXPIRED";
    const days = Math.round((t.exp - now) / 86400);
    return days >= 1 ? `valid, ${days}d left` : "valid, <1d left";
  }
  return "valid";
}

// Best-effort browser open for the verification URL. No-op on a headless box
// (linux with no DISPLAY/WAYLAND) so an SSH session just reads the code. Never
// throws and never blocks (detached + unref).
function tryOpenBrowser(url) {
  try {
    const { spawn } = require("child_process");
    let cmd;
    let args;
    if (process.platform === "darwin") {
      cmd = "open";
      args = [url];
    } else if (process.platform === "win32") {
      cmd = "cmd";
      args = ["/c", "start", "", url];
    } else {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false; // headless
      cmd = "xdg-open";
      args = [url];
    }
    const c = spawn(cmd, args, { stdio: "ignore", detached: true });
    c.on("error", () => {});
    c.unref();
    return true;
  } catch {
    return false;
  }
}

// Confirm a {server, token} against /v1/me, then ADD it to the credential store
// (never clobbering a sibling tenant). Shared by `auth login` (device + paste)
// and `join`. Returns an exit code.
async function acquireTenant(cfg, { server, token, org, refresh_token, exp, label, makeDefault }) {
  server = auth.normServer(server);
  if (!server) {
    err("a server URL is required");
    return 1;
  }
  let person = null;
  let email = null;
  let resolvedOrg = org || auth.jwtOrg(token) || "";
  if (token) {
    // Confirm against the server the credential is FOR; honor an env SPOR_SERVER
    // redirect (as the prior cascade-based `join` confirm did) so a single-tenant
    // env points the probe and tests stay hermetic.
    const me = await fetchMe(u.envDual("SERVER") || server, token);
    if (me.ok && me.json) {
      person = me.json.person || null;
      email = me.json.email || null;
      // Opaque-token tenants (spor_oat_/spor_pat_) carry no client-readable org,
      // so jwtOrg() is empty and they would all key to "<server>/" and collide.
      // The server now echoes the resolved org on /v1/me (task-spor-frontdoor-
      // me-org-echo) — fall back to it, AFTER --org and the JWT `org` claim, so a
      // person in >1 org on one opaque server keys distinct credentials.
      if (!resolvedOrg && typeof me.json.org === "string" && me.json.org) {
        resolvedOrg = me.json.org;
      }
      if (me.json.bound === false) {
        out(`⚠ token maps to no person node — routed questions and your personal queue will be empty`);
      }
    } else if (me.status === 401 || me.status === 403) {
      err(`token rejected by ${server} (${me.status}) — not stored`);
      return 1;
    } else if (me.transport) {
      out(`note: could not reach ${server} to confirm identity (${me.error}); storing anyway`);
    } else if (me.status && me.status !== 404) {
      out(`note: could not confirm identity (/v1/me ${me.status}); storing anyway`);
    }
  }
  const exp2 = exp != null ? exp : auth.jwtExp(token);
  const res = auth.upsertTenant(cfg.userConfigHome(), {
    server,
    org: resolvedOrg,
    access_token: token || "",
    ...(refresh_token ? { refresh_token } : {}),
    ...(exp2 ? { exp: exp2 } : {}),
    ...(person ? { person } : {}),
    ...(email ? { email } : {}),
    ...(label ? { label } : {}),
  }, makeDefault !== undefined ? { makeDefault } : {});
  const who = person ? ` as ${person}${email ? ` <${email}>` : ""}` : "";
  out(`stored credential for ${resolvedOrg || "(no org)"} @ ${server}${who}`);
  out(`  ${auth.credentialsPath(cfg.userConfigHome())}`);
  if (res.becameDefault) out(`  active tenant: ${res.key}`);
  else out(`  (run 'spor auth switch ${resolvedOrg || res.key}' to make it active)`);
  return 0;
}

// `spor auth login` / flat `spor login` — interactive sign-in, default = the
// RFC 8628 device authorization grant (works headless / over SSH). Paste-compat:
// `login <url> <token>` skips the device flow and stores a pasted PAT, exactly
// like `join` (so the historical `spor login <url> <token>` keeps working).
async function cmdAuthLogin(cfg, args) {
  const web = args.includes("--web");
  const all = args.includes("--all");
  const noOpen = args.includes("--no-open");
  const serverFlag = optVal(args, "server");
  const scope = optVal(args, "scope") || undefined;
  // --org is lifted to a global flag in main() (it selects a tenant for any
  // verb); read it from the resolved cascade, falling back to an inline --org.
  const org = cfg.flagOrg() || optVal(args, "org") || undefined;
  // bare positionals (not a flag and not a flag's value)
  const FLAGVAL = new Set(["--server", "--scope", "--org"]);
  const pos = args.filter((a, i) => !a.startsWith("-") && !(i > 0 && FLAGVAL.has(args[i - 1])));

  // Paste path: `login <url> <token>` (or a single bare URL).
  if (pos.length && /^https?:\/\//.test(pos[0])) {
    return acquireTenant(cfg, { server: pos[0], token: pos[1] || "", org, makeDefault: true });
  }

  // Default to the hosted Spor front door when no server is named — onboarding
  // parity with `spor join <token>` (task-spor-api-cli-default-server-base).
  // serverForNewTenant(), not server(): `--org <new>` is legitimate here (it
  // names the org this login will ESTABLISH), and it leaves server() empty
  // (issue-spor-cli-unrecognized-org-fallback).
  const server = auth.normServer(serverFlag || cfg.serverForNewTenant() || DEFAULT_SERVER);
  if (all) {
    out("note: --all (one token per org in a single leg) needs the front-door membership");
    out("      endpoint (task-spor-frontdoor-org-membership-enumeration), not yet shipped —");
    out("      logging into one org for now; re-run 'spor auth login --org <other>' for more.");
  }

  // --web: the localhost-loopback variant (auth code + PKCE), the browser-local
  // optimization. It falls back to the device grant when the server has no
  // loopback/DCR support (task-cc-spor-auth-cli-web-loopback).
  if (web) {
    const r = await loginViaLoopback(cfg, { server, org, scope, noOpen });
    if (r !== "fallback") return r;
    out("note: this server has no loopback/DCR endpoints — using the device-code flow.");
  }

  return loginViaDevice(cfg, { server, org, scope, noOpen });
}

// The default interactive flow: the RFC 8628 device authorization grant. Works
// headless / over SSH — the human approves in a browser on their OWN machine, so
// no local listener or port-forward is needed. Returns an exit code.
async function loginViaDevice(cfg, { server, org, scope, noOpen }) {
  // RFC 8628 §3.1 — start the device authorization. The RFC 8707 `resource` indicator
  // is the api host this token will call (`server`), so the issuer can scope the minted
  // token's `aud` to it (task-spor-app-api-strict-audience-restriction). Inert against an
  // un-armed / self-host issuer, so it is always safe to send.
  const da = await auth.deviceAuthorize(server, { scope, resource: server });
  if (da.transport) {
    err(`offline — could not reach ${server} (${da.error})`);
    return 1;
  }
  if (!da.ok || !da.json || !da.json.device_code) {
    const msg = oauthErrMsg(da.json);
    err(`device authorization failed (${da.status}${msg ? ` — ${msg}` : ""})`);
    if (da.status === 404) {
      err(`  ${server} has no device endpoints — needs the front-door device grant`);
      err(`  (task-spor-frontdoor-device-authorization-endpoints). Paste a token instead:`);
      err(`  spor auth login ${server} <token>`);
    }
    return 1;
  }
  const d = da.json;
  const interval = Number(d.interval) > 0 ? Number(d.interval) : 5;
  const expiresIn = Number(d.expires_in) > 0 ? Number(d.expires_in) : 900;
  out(`To sign in, open this URL in a browser:`);
  out(`  ${d.verification_uri_complete || d.verification_uri}`);
  out(`and enter the code:  ${d.user_code}`);
  out(``);
  if (!noOpen) tryOpenBrowser(d.verification_uri_complete || d.verification_uri);
  out(`Waiting for approval (Ctrl-C to cancel)…`);

  // RFC 8628 §3.4 — poll, honoring interval/slow_down, until approval or expiry.
  const deadline = Date.now() + expiresIn * 1000;
  let pollMs = interval * 1000;
  let tokens = null;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const r = await auth.devicePoll(server, d.device_code);
    if (r.ok && r.json && r.json.access_token) {
      tokens = r.json;
      break;
    }
    const e = r.json && r.json.error;
    if (e === "authorization_pending") continue;
    if (e === "slow_down") {
      pollMs += 5000;
      continue;
    }
    if (e === "access_denied") {
      err("authorization was denied.");
      return 1;
    }
    if (e === "expired_token") {
      err("the code expired before approval — run 'spor auth login' again.");
      return 1;
    }
    if (r.transport) continue; // transient network blip — keep polling
    err(`login failed: ${oauthErrMsg(r.json) || `status ${r.status}`}`);
    return 1;
  }
  if (!tokens) {
    err("timed out waiting for approval — run 'spor auth login' again.");
    return 1;
  }
  const exp =
    tokens.expires_in != null ? Math.floor(Date.now() / 1000) + Number(tokens.expires_in) : auth.jwtExp(tokens.access_token);
  return acquireTenant(cfg, {
    server,
    token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    org,
    exp,
    makeDefault: true,
  });
}

// The minimal page the loopback redirect lands on: the human reads it in the
// browser and returns to the terminal. No external assets (the loopback server
// is one-shot), Connection: close so the browser drops the socket and the CLI
// process can exit.
function loopbackPage(ok, detail) {
  const e = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const title = ok ? "Signed in to Spor" : "Sign-in failed";
  const body = ok
    ? "You're signed in. You can close this tab and return to your terminal."
    : `Sign-in did not complete${detail ? ` (${e(detail)})` : ""}. Return to your terminal and try again.`;
  return (
    `<!doctype html><meta charset="utf-8"><title>${e(title)}</title>` +
    `<body style="font:15px/1.5 system-ui,-apple-system,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#16242b">` +
    `<h1 style="font-size:1.15rem;margin:0 0 .5rem">${e(title)}</h1><p style="margin:0">${body}</p></body>`
  );
}

// `spor auth login --web` — the localhost-loopback variant (OAuth 2.1
// authorization-code + PKCE, RFC 8252), the browser-local optimization over the
// device grant. Bind a one-shot 127.0.0.1 listener, anonymously DCR-register a
// public client for its exact loopback redirect, open the browser to
// /oauth/authorize, capture the redirected ?code (CSRF-checked against state),
// and exchange it (+ the PKCE verifier) for the org-scoped token pair. Returns
// an exit code, or the string "fallback" when the server has no loopback/DCR
// support (the caller then runs the device grant). task-cc-spor-auth-cli-web-loopback.
async function loginViaLoopback(cfg, { server, org, scope, noOpen }) {
  const http = require("http");
  // PKCE (S256, RFC 7636) + a CSRF state (RFC 6749 §10.12). base64url throughout.
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("base64url");

  // 1) Bind the loopback listener FIRST: the redirect_uri must carry the real
  //    bound port (the front door exact-matches it at /oauth/authorize), and the
  //    browser may arrive the instant the URL opens.
  let settle;
  const captured = new Promise((resolve) => {
    settle = resolve;
  });
  let done = false;
  const finish = (v) => {
    if (!done) {
      done = true;
      settle(v);
    }
  };
  const srv = http.createServer((req, res) => {
    let reqUrl;
    try {
      reqUrl = new URL(req.url, "http://127.0.0.1");
    } catch {
      res.writeHead(400, { connection: "close" });
      res.end();
      return;
    }
    if (reqUrl.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain", connection: "close" });
      res.end("not found");
      return;
    }
    const qp = reqUrl.searchParams;
    const oauthErr = qp.get("error");
    const code = qp.get("code");
    const stateOk = qp.get("state") === state;
    const ok = !oauthErr && !!code && stateOk;
    const detail = oauthErr || (!stateOk ? "state mismatch" : !code ? "no code" : "");
    res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8", connection: "close" });
    res.end(loopbackPage(ok, detail));
    if (oauthErr) finish({ error: oauthErr });
    else if (!stateOk) finish({ error: "state_mismatch" });
    else if (code) finish({ code });
    else finish({ error: "no_code" });
  });
  try {
    await new Promise((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", resolve);
    });
  } catch (e) {
    err(`could not bind a loopback listener (${e.message}); using the device-code flow.`);
    return "fallback";
  }
  const port = srv.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // 2) Anonymous DCR — register the public client for this exact redirect.
  const reg = await auth.registerClient(server, { redirectUris: [redirectUri], clientName: "spor CLI (loopback)" });
  if (reg.transport) {
    srv.close();
    err(`offline — could not reach ${server} (${reg.error})`);
    return 1;
  }
  if (reg.status === 404) {
    srv.close();
    return "fallback"; // front door has no DCR endpoint
  }
  if (!reg.ok || !reg.json || !reg.json.client_id) {
    srv.close();
    const msg = oauthErrMsg(reg.json);
    err(`client registration failed (${reg.status}${msg ? ` — ${msg}` : ""})`);
    return 1;
  }
  const clientId = reg.json.client_id;
  const regToken = reg.json.registration_access_token;
  const regUri = reg.json.registration_client_uri;

  // 3) Build the authorize URL and open the browser.
  const authUrl = new URL(`${server}/oauth/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  if (scope) authUrl.searchParams.set("scope", scope);
  // RFC 8707 resource indicator — the api host this token will call (`server`), so
  // the issuer can scope the minted token's `aud` to it (task-spor-app-api-strict-
  // audience-restriction). Echoed at the token exchange below. Inert when un-armed.
  authUrl.searchParams.set("resource", server);

  out(`To sign in, open this URL in a browser on this machine:`);
  out(`  ${authUrl.toString()}`);
  out(``);
  if (!noOpen) tryOpenBrowser(authUrl.toString());
  out(`Waiting for the browser to complete sign-in (Ctrl-C to cancel)…`);

  // 4) Await the redirect (bounded), then stop listening.
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ error: "timeout" }), 5 * 60_000);
  });
  const result = await Promise.race([captured, timeout]);
  clearTimeout(timer);
  srv.close();

  // 5) Clean up the throwaway client (best-effort; the grant does not need it).
  await auth.unregisterClient(regUri, regToken);

  if (result.error) {
    if (result.error === "timeout") err("timed out waiting for the browser — run 'spor auth login --web' again.");
    else if (result.error === "access_denied") err("authorization was denied.");
    else if (result.error === "state_mismatch") err("the redirect failed its CSRF (state) check — login aborted.");
    else err(`login failed: ${result.error}`);
    return 1;
  }

  // 6) Exchange the code (+ PKCE verifier) for the org-scoped token pair.
  const tok = await auth.exchangeCode(server, { code: result.code, codeVerifier: verifier, clientId, redirectUri, resource: server });
  if (tok.transport) {
    err(`offline — token exchange not completed (${tok.error})`);
    return 1;
  }
  if (!tok.ok || !tok.json || !tok.json.access_token) {
    const msg = oauthErrMsg(tok.json);
    err(`token exchange failed (${tok.status}${msg ? ` — ${msg}` : ""})`);
    return 1;
  }
  const tokens = tok.json;
  const exp =
    tokens.expires_in != null ? Math.floor(Date.now() / 1000) + Number(tokens.expires_in) : auth.jwtExp(tokens.access_token);
  return acquireTenant(cfg, {
    server,
    token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    org,
    exp,
    makeDefault: true,
  });
}

// One stored-tenant display line, shared by the cached and the live listings.
// Byte-identical to the inline form `auth list` printed before the live
// re-query landed (norm-cc-byte-identical-refactor).
function tenantLine(t, mark) {
  const idn = t.person ? `  ${t.person}${t.email ? ` <${t.email}>` : ""}` : t.email ? `  <${t.email}>` : "";
  return `${mark} ${t.org || "(no org)"}  ${t.server}${idn}  [${tokenHealth(t)}]`;
}

// Render the LIVE org membership for one issuer (GET /v1/me/org-choices,
// source:idp) joined against the stored tenants. Surfaces three states the
// cached listing can't: an org you belong to but hold NO credential for yet
// (a login hint), a stored credential the IdP no longer reports (revoked or
// stale), and stored credentials on OTHER issuers — out of scope for this
// single-issuer re-query, but never hidden, since `auth list` must always
// show every credential the user holds.
function listLiveMembership(store, srv, choices) {
  const onSrv = new Map(); // org -> { key, t }, stored tenants on this issuer
  const other = []; // { key, t } on a different issuer
  for (const k of Object.keys(store.tenants)) {
    const t = store.tenants[k];
    if (auth.normServer(t.server) === srv) onSrv.set(t.org || "", { key: k, t });
    else other.push({ key: k, t });
  }
  const shown = new Set();
  for (const c of choices) {
    const org = (c && c.slug) || "";
    const have = onSrv.get(org);
    if (have) {
      shown.add(org);
      out(tenantLine(have.t, have.key === store.default ? "*" : " "));
    } else {
      // belong to the org, no local credential — the genuinely new live signal
      const label = c && c.label && c.label !== org ? `  (${c.label})` : "";
      out(`  ${org || "(no org)"}  ${srv}${label}  [no credential — run 'spor auth login --org ${org}']`);
    }
  }
  // Stored credentials on this issuer the live membership did NOT report — the
  // token still works, but the IdP no longer lists you in that org.
  for (const [org, { key, t }] of onSrv) {
    if (shown.has(org)) continue;
    out(`${tenantLine(t, key === store.default ? "*" : " ")}  (not in current membership)`);
  }
  for (const { key, t } of other) out(tenantLine(t, key === store.default ? "*" : " "));
}

// `spor auth list` — every stored tenant, which is active, and token health,
// REFRESHED LIVE when the server supports it. A single GET /v1/me/org-choices
// against the active tenant's issuer enumerates every org the person currently
// belongs to (task-spor-cli-auth-list-live-membership-requery), so an org
// added or removed since the last login surfaces without re-authenticating.
// remote.get resolves the active credential through the cascade and refreshes
// it transparently on a 401, so a stale-but-refreshable active token still
// re-queries. Fail-open like the rest of the client (dec-cc-fail-open-hooks):
// only `source: "idp"` is a true live enumeration — a tenant-`bound`
// single-org token, a 502 `membership_requery_failed`, an older server with no
// endpoint (404), and any offline/unparseable response all fall through to the
// cached store listing, byte-identical to the pre-live behavior.
async function cmdAuthList(cfg) {
  const store = auth.readStore(cfg.userConfigHome());
  const keys = Object.keys(store.tenants);
  if (!keys.length) {
    // migrate-on-read: surface a legacy flat config server+token as the implicit
    // tenant it resolves to (it will move into the store on the next login/join).
    const t = cfg.tenant();
    if (t && t.source === "flat-config" && t.server) {
      out(`* ${t.org || "(no org)"}  ${t.server}  [legacy flat config — run 'spor auth login' to migrate]`);
      return 0;
    }
    out("no stored credentials. Run 'spor auth login' (or 'spor join <url> <token>').");
    return 0;
  }

  const srv = auth.normServer(remote.base(cfg));
  let live = null;
  if (srv) {
    const r = await remote.get(cfg, "/v1/me/org-choices", { timeoutMs: 5000 });
    if (r.ok && r.json && r.json.source === "idp" && Array.isArray(r.json.org_choices)) {
      live = r.json.org_choices;
    }
  }

  if (live) {
    listLiveMembership(store, srv, live);
  } else {
    for (const k of keys) out(tenantLine(store.tenants[k], k === store.default ? "*" : " "));
  }
  out(``);
  out(`* = active tenant. Switch with 'spor auth switch <org>'.`);
  if (live) out(`membership refreshed live from ${srv}.`);
  return 0;
}

// `spor auth switch <org>` — set the active (default) tenant.
function cmdAuthSwitch(cfg, args) {
  const sel = args.find((a) => !a.startsWith("-"));
  if (!sel) {
    err("usage: spor auth switch <org>");
    return 1;
  }
  const r = auth.setDefault(cfg.userConfigHome(), sel);
  if (r.ambiguous) {
    err(`'${sel}' matches more than one tenant: ${r.ambiguous.join(", ")}`);
    err(`  switch by full key, e.g. 'spor auth switch ${r.ambiguous[0]}'`);
    return 1;
  }
  if (!r.ok) {
    err(`no stored tenant for '${sel}' — 'spor auth list' shows what you have.`);
    return 1;
  }
  out(`active tenant: ${r.key}`);
  return 0;
}

// `spor auth whoami [--all]` — identity for the active tenant, or every tenant.
async function cmdAuthWhoami(cfg, args) {
  if (args.includes("--all")) {
    const store = auth.readStore(cfg.userConfigHome());
    const keys = Object.keys(store.tenants);
    if (!keys.length) {
      out("no stored credentials. Run 'spor auth login'.");
      return 0;
    }
    for (const k of keys) {
      const t = store.tenants[k];
      const mark = k === store.default ? "*" : " ";
      out(
        `${mark} ${t.org || "(no org)"} @ ${t.server}: ${t.person || "(unbound)"}${t.email ? ` <${t.email}>` : ""}  [${tokenHealth(t)}]`,
      );
    }
    return 0;
  }
  return cmdWhoami(cfg);
}

// `spor auth logout [<org> | --all]` — clear one tenant, the active one, or all.
function cmdAuthLogout(cfg, args) {
  if (args.includes("--all")) {
    const n = auth.clearAll(cfg.userConfigHome());
    out(`cleared ${n} tenant${n === 1 ? "" : "s"}.`);
    return 0;
  }
  const sel = args.find((a) => !a.startsWith("-"));
  if (!sel) {
    const store = auth.readStore(cfg.userConfigHome());
    if (!store.default) {
      err("no active tenant to log out of — pass an <org>, or 'spor auth logout --all'.");
      return 1;
    }
    const r = auth.removeTenant(cfg.userConfigHome(), store.default);
    out(`logged out of ${r.key}`);
    return 0;
  }
  const r = auth.removeTenant(cfg.userConfigHome(), sel);
  if (r.ambiguous) {
    err(`'${sel}' matches more than one tenant: ${r.ambiguous.join(", ")}`);
    return 1;
  }
  if (!r.ok) {
    err(`no stored tenant for '${sel}' — 'spor auth list' shows what you have.`);
    return 1;
  }
  out(`logged out of ${r.key}`);
  return 0;
}

// `spor auth <sub>` dispatcher (raw-parsed, like `agent`/`token`).
async function cmdAuth(cfg, args) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "login":
      return await cmdAuthLogin(cfg, rest);
    case undefined:
    case "list":
      return await cmdAuthList(cfg);
    case "switch":
      return cmdAuthSwitch(cfg, rest);
    case "whoami":
      return await cmdAuthWhoami(cfg, rest);
    case "logout":
      return cmdAuthLogout(cfg, rest);
    default:
      err("usage: spor auth login [--web] [--org <slug>] [--all] | list | switch <org> | whoami [--all] | logout [<org>|--all]");
      return 1;
  }
}

// --- spor join ----------------------------------------------------------
// Point the client at a team graph by APPENDING an org-scoped credential to the
// multi-tenant store (never overwriting a sibling tenant — dec-spor-client-cli-
// mode-tenant-resolution). The non-interactive paste path; `spor auth login` is
// the interactive (device-grant) acquirer.
//
// The server URL defaults to the hosted Spor base (DEFAULT_SERVER,
// task-spor-api-cli-default-server-base) when omitted, so onboarding to the
// hosted service is `spor join <token>` rather than requiring the URL. A first
// positional that looks like a token (spor_pat_…) is taken as the token, not the
// server, so the one-arg form is unambiguous; an explicit URL still wins.
async function cmdJoin(cfg, { values, positionals }) {
  let server = values.server;
  let token = values.token;
  const pos = positionals.slice();
  // First positional is the server URL unless it is clearly a token (the
  // one-arg hosted-join form), in which case it falls through to the token slot.
  if (!server && pos.length && !looksLikeToken(pos[0])) server = pos.shift();
  if (!token && pos.length) token = pos.shift();
  const usedDefault = !server;
  if (usedDefault) server = DEFAULT_SERVER; // hosted-onboarding default
  if (usedDefault) out(`using the hosted Spor default ${server} (pass a URL to point at your own server)`);
  if (!token) out(`note: no token given — set SPOR_TOKEN or 'spor join <server> <token>' to authenticate`);
  return acquireTenant(cfg, { server, token, org: cfg.flagOrg() || undefined, makeDefault: undefined });
}

// --- spor invite / token: admin onboarding (wraps /v1/admin/tokens) --------
// Remote + admin only (the server gates on the stewards→root edge). invite
// mints a person-bound token and prints a paste-ready join line, optionally
// creating the person node first — closing the blind, out-of-band token
// hand-off the team-onboarding research flagged.
function notAdminHint(r) {
  if (r.status === 403) {
    err("forbidden — admin privilege required (a stewards→root edge AND a person-bound token).");
    err("your token may be legacy/email-matched; check 'spor whoami' (is_admin).");
    return true;
  }
  return false;
}

async function cmdInvite(cfg, { values }) {
  if (cfg.mode() !== "remote") {
    err("invite needs a team graph — set SPOR_SERVER/SPOR_TOKEN (see 'spor join').");
    return 1;
  }
  let person = values.person;
  const name = values.name;
  const email = values.email;
  const expires = values.expires;

  // create the person node first when only name/email is given (the mint
  // endpoint binds to an EXISTING node, it cannot conjure a subject).
  if (!person) {
    if (!name || !email) {
      err("usage: spor invite --person <id> [--expires <Nd>]");
      err("   or: spor invite --name <name> --email <email> [--id person-x] [--expires <Nd>]");
      return 1;
    }
    person = values.id || personIdForEmail(email);
    const safeName = name.replace(/\n/g, " ");
    const md = `---\nid: ${person}\ntype: person\ntitle: ${safeName}\nname: ${safeName}\nsummary: Team member ${safeName}.\nemail: ${email}\ndate: ${today()}\n---\n\nTeam member ${safeName} <${email}>.\n`;
    const pr = await remote.post(cfg, "/v1/nodes", { nodes: [{ node: md, if_exists: "skip" }] });
    if (pr.transport) {
      err(`offline — could not reach server (${pr.error})`);
      return 1;
    }
    if (notAdminHint(pr)) return 1;
    const res0 = pr.json && pr.json.results && pr.json.results[0];
    if (!pr.ok && !(res0 && res0.ok)) {
      err(`could not create person node: ${(res0 && res0.message) || pr.status}`);
      return 1;
    }
    out(`person node ${labelledPerson(safeName, person)} ${res0 && res0.status === "skipped" ? "(already existed)" : "created"}`);
  }

  const r = await remote.post(cfg, "/v1/admin/tokens", { person, ...(expires ? { expires } : {}) });
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (notAdminHint(r)) return 1;
  if (r.status === 404) {
    err(`no such person node '${person}' — pass --name/--email to create one`);
    return 1;
  }
  if (!r.ok) {
    err(`mint failed (${r.status}): ${(r.json && r.json.error && r.json.error.message) || r.text}`);
    return 1;
  }
  const j = r.json;
  out(`minted token for ${labelledPerson(j.name, j.person)} <${j.email}>${j.expires ? ` (expires ${j.expires})` : ""} [${j.hash_prefix}]`);
  out(`  give this to the teammate ONCE — it is not recoverable:\n`);
  out(`  spor join ${remote.base(cfg)} ${j.token}\n`);
  out(`  revoke later with: spor admin token revoke ${j.hash_prefix}`);
  return 0;
}

// --- spor person: the local identity anchor -------------------------------
// task-spor-onboard-cli-person-node: onboarding's local branch must create the
// `type: person` node the queue's $viewer binding resolves to, but no client
// verb did this in local mode — `spor agent create` needs a pre-existing person
// to own the agent, and `spor invite` (the only person-creating path) is remote
// + admin-gated. This is the deterministic local door: seed title/email from the
// graph home's git identity (the SAME read lib/queue.js's gitIdentityEmail uses
// to bind $viewer, so the node it writes is guaranteed to resolve back), then
// write it through the same validate-before-write path cmdAgentCreateLocal uses.
async function cmdPerson(cfg, args) {
  const sub = args[0];
  if (sub === "create") {
    const posName = args[1] && !args[1].startsWith("-") ? args[1] : null;
    return cmdPersonCreate(cfg, {
      name: optVal(args, "name") || posName,
      email: optVal(args, "email"),
      id: optVal(args, "id"),
    });
  }
  if (!sub || sub === "list") return cmdPersonList(cfg);
  err("usage: spor person create [<name>] [--email <e>] [--id person-x] | spor person list");
  return 1;
}

// Write a `type: person` node to the local graph home, seeding name/email from
// the graph home's git identity when not given. Idempotent: a re-run that finds
// a person node already bound to this git identity reports it and exits 0, so the
// onboarding skill can call it unconditionally.
async function cmdPersonCreate(cfg, { name, email, id }) {
  // Person creation in remote mode is server-owned: your own node is minted with
  // your token, teammates via the admin-gated `spor invite`. Redirect rather than
  // write a stray local file under a server.
  if (cfg.mode() === "remote") {
    err("remote mode — your person node is managed by the team server (see 'spor whoami').");
    err("  create a teammate's person node with 'spor invite --name <n> --email <e>' (admin).");
    return 1;
  }
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  const queueLib = require(path.join(ROOT, "lib", "queue.js"));
  ensureGraphHome(cfg); // bootstrap git + .gitignore + nodes/ (idempotent, == spor init)
  // Write to the authoritative nodes dir (honors a `nodes`/`--nodes` override) and
  // seed the git identity from the SAME dir the queue's $viewer binding reads —
  // path.dirname(nodesDir), per localMuteNoOp / lib/queue.js — so the default
  // email is guaranteed to resolve back to this node even if the dir is relocated.
  const nodesDir = cfg.nodesDir();
  if (!fs.existsSync(nodesDir)) fs.mkdirSync(nodesDir, { recursive: true });
  const ident = gitIdentity(path.dirname(nodesDir));
  email = (email || ident.email || "").trim();
  name = (name || ident.name || "").trim();
  // ensureGraphHome (== spor init) seeds `git config user.email = spor@localhost`
  // when the box has no real identity, so the graph can auto-commit
  // (ensureGitIdentity). That fallback is for COMMIT-ability only — it must NOT
  // bind a person node, because the email is the $viewer key the local queue keys
  // off; a `spor@localhost` binding is junk. Treat the sentinel as no real
  // identity so the guard below fires (an explicit `--email spor@localhost` is
  // refused too — there's no legitimate person at that address).
  const FALLBACK_EMAIL = "spor@localhost";
  if (email === FALLBACK_EMAIL) {
    err("no real git identity (found the spor@localhost commit fallback) — set 'git config user.email you@example.com' first; the fallback is for auto-commits and won't bind a person node.");
    err("  the email is the $viewer key the local queue binds your git identity to; pass --email to override.");
    return 1;
  }
  if (!email) {
    err("no email for the person node — pass --email, or set 'git config user.email'.");
    err("  the email is the $viewer key the local queue binds your git identity to; without it the node won't bind.");
    return 1;
  }
  // Title is required; fall back to the email local-part before giving up.
  if (!name) name = email.split("@")[0] || "";
  if (!name) {
    err("no name for the person node — pass --name, or set 'git config user.name'.");
    return 1;
  }

  let g;
  try {
    g = graphLib.loadGraph(nodesDir);
  } catch (e) {
    err(`could not load graph: ${e.message}`);
    return 1;
  }
  // Idempotent: a person node already binding this git identity is success, not a
  // collision — the onboarding skill calls this unconditionally.
  const existing = queueLib.viewerFor(g, email);
  if (existing) {
    out(`person node ${existing.id} already represents <${email}> — nothing to do`);
    return 0;
  }

  const prefix = (g.registry && g.registry.prefixesFor("person") || ["person-"])[0] || "person-";
  if (id) {
    // An explicit --id must be a canonical kebab slug under the prefix — the same
    // shape the server's SLUG_RE enforces (mirrors isAgentId), so a hand-passed id
    // can't write a non-canonical node file. The default path is always kebab'd.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !id.startsWith(prefix)) {
      err(`person id '${id}' must be a kebab '${prefix}<slug>' id (lowercase a-z, 0-9, -)`);
      return 1;
    }
  } else {
    id = personIdForEmail(email);
  }
  if (!id) {
    err("could not derive a stable person id from the email — pass --id explicitly");
    return 1;
  }
  if (fs.existsSync(path.join(nodesDir, `${id}.md`))) {
    err(`person node already exists: ${id} (pass --id to choose another)`);
    return 1;
  }

  // Scrub newlines from both interpolated values so a pathological --name/--email
  // can't inject an extra frontmatter line (the parser is line-based key: value).
  const safeName = name.replace(/\n/g, " ");
  const safeEmail = email.replace(/\n/g, " ");
  const md =
    `---\nid: ${id}\ntype: person\ntitle: ${safeName}\n` +
    `name: ${safeName}\n` +
    `summary: Org member ${safeName} <${safeEmail}> — the local $viewer identity anchor for this graph's queue.\n` +
    `email: ${safeEmail}\ndate: ${today()}\n---\n\n` +
    `Org member ${safeName} <${safeEmail}>. Created locally by \`spor person create\`; the git-identity ($viewer) anchor the local queue and queue_mute bind to (lib/queue.js viewerFor).\n`;
  let node;
  try {
    node = graphLib.parseFrontmatter(md, `${id}.md`);
  } catch (e) {
    err(`invalid node: ${e.message}`);
    return 1;
  }
  const v = graphLib.validateNode(g, node);
  if (!v.ok) {
    err(`invalid person node:\n  ${v.errors.join("\n  ")}`);
    return 1;
  }
  fs.writeFileSync(path.join(nodesDir, `${id}.md`), md);
  out(`created person ${labelledPerson(safeName, id)} <${email}>`);
  out(`  next: create this machine's agent identity — spor agent create <label>`);
  return 0;
}

// List the local graph's person nodes, marking the one this box's git identity
// binds to (the $viewer). Local-only — remote identity is 'spor whoami'.
function cmdPersonList(cfg) {
  if (cfg.mode() === "remote") {
    err("remote mode — use 'spor whoami' for your server identity.");
    return 1;
  }
  const nodesDir = cfg.nodesDir();
  if (!fs.existsSync(nodesDir)) {
    out("no graph yet — run 'spor person create' (or 'spor init').");
    return 0;
  }
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  const queueLib = require(path.join(ROOT, "lib", "queue.js"));
  let g;
  try {
    g = graphLib.loadGraph(nodesDir);
  } catch (e) {
    err(`could not load graph: ${e.message}`);
    return 1;
  }
  const people = Object.values(g.nodes || {}).filter((n) => n.type === "person");
  if (!people.length) {
    out("no person nodes — create one with 'spor person create'.");
    return 0;
  }
  const viewer = queueLib.viewerFor(g, gitIdentity(path.dirname(nodesDir)).email);
  for (const p of people) {
    const me = viewer && viewer.id === p.id ? "  ← you (git identity)" : "";
    out(`${personDisplayName(p, p.id)}\t${p.email || "(no email)"}\t${p.id}${me}`);
  }
  return 0;
}

// --- spor agent: a person-owned automation principal ----------------------
// dec-spor-agent-identity-nodes: an agent is a first-class `type: agent` node
// owned by a person via an `owned-by` edge, so a dispatched session's writes
// read "agent on behalf of person" instead of person-direct. One persistent
// node per machine/install, created once here and reused across dispatches.
//
// REMOTE: the SELF-SERVE POST /v1/agents creates the node owned by the caller
//   (no admin gate, owner = your bound person — task-spor-app-agents-self-serve-
//   create). Creating on behalf of ANOTHER person (--owner person-x) needs the
//   admin twin POST /v1/admin/agents (admin-gated). FAIL-SOFT on 404 — an old
//   server lacking the route gets a clear message, not a crash.
// LOCAL: write the agent node + owned-by edge to the graph home via the same
//   lib/graph validate-before-write path cmdAdd uses; the spiffe is built
//   client-side from a config `org` (forward-compat shape, unenforced).
async function cmdAgent(cfg, args) {
  const sub = args[0];
  if (sub === "create") {
    const label = args[1];
    if (!label || label.startsWith("-")) {
      err("usage: spor agent create <label> [--owner person-x] [--pubkey <fp>]");
      return 1;
    }
    const owner = optVal(args, "owner");
    const pubkey = optVal(args, "pubkey") || "";
    return cfg.mode() === "remote"
      ? cmdAgentCreateRemote(cfg, { label, owner, pubkey })
      : cmdAgentCreateLocal(cfg, { label, owner, pubkey });
  }
  if (!sub || sub === "list") {
    return cfg.mode() === "remote" ? cmdAgentListRemote(cfg) : cmdAgentListLocal(cfg);
  }
  if (sub === "use") {
    return cmdAgentUse(cfg, { id: args[1] });
  }
  if (sub === "token") {
    return cmdAgentToken(cfg, args.slice(1));
  }
  err("usage: spor agent create <label> [--owner person-x] [--pubkey <fp>] | spor agent list | spor agent use <agent-id> | spor agent token <agent-id> [list|revoke <prefix>]");
  return 1;
}

// A valid Spor agent id, mirroring the server's token-mint contract EXACTLY
// (spor-server server/rest.js: `SLUG_RE.test(id) && id.startsWith("agent-")`).
// The `agent-` prefix is load-bearing: the agent NODE id carries it, but the
// `spor agent create`/`list` output also prints the bare LABEL, so copying the
// label into `spor agent use`/`dispatch --as` is an easy slip — and the bare
// slug passes a plain kebab check while the server's POST /v1/agents/{id}/token
// 422s on it (invalid_node), silently dropping the dispatch to person-scoped.
// One predicate, used by every client setter that feeds that endpoint, so the
// client never accepts an id the server rejects
// (issue-spor-dispatch-agent-id-prefix-validation-gap).
function isAgentId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(id) && id.startsWith("agent-");
}

// When a rejected id is a valid kebab slug that merely DROPPED the `agent-`
// prefix (the common label-vs-id slip), suggest the prefixed form; else null.
function agentIdGuess(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(id) && !id.startsWith("agent-")
    ? `agent-${id}`
    : null;
}

// Resolve a bare agent LABEL (what `spor agent create`/`spor agent list` print
// alongside the id) against the caller's own agents, so `spor agent use <label>`
// is a convenience instead of the prefix-hint error
// (task-spor-agent-use-label-resolution — the deferred follow-up to
// isAgentId()/agentIdGuess() above). Remote: GET /v1/agents (already scoped to
// agents the caller owns; `label` per API.md's documented shape), falling back
// to the /v1/changes audit projection on a 404 (an old server without the
// dedicated route) exactly like cmdAgentListRemote does — so `use` never
// rejects a label `list` can still show. Local: scan the graph's `type: agent`
// nodes (their frontmatter carries the label as `title`). Matches on whichever
// of `label`/`title` the source carries, OR the plain `agent-<label>`
// prefixing, so both a re-typed label and a copy-pasted un-prefixed id
// resolve. Returns {id} on a unique match, {ambiguous:[...ids]} on more than
// one, or null on no match — including any lookup failure, since this stays a
// convenience layered on top of the existing hint, never a hard dependency
// (the deferral's stated reason for not doing this eagerly: a networked lookup
// needs offline fail-soft, so any failure here just falls through to the
// pre-existing invalid-id error).
async function resolveAgentIdFromLabel(cfg, label) {
  const guessedId = `agent-${kebab(label)}`;
  const isMatch = (a) => a && (a.label === label || a.title === label || a.id === guessedId);
  try {
    let agents;
    if (cfg.mode() === "remote") {
      const r = await remote.get(cfg, "/v1/agents", { timeoutMs: 6000 });
      if (r.ok && r.json && Array.isArray(r.json.agents)) {
        agents = r.json.agents;
      } else if (r.status === 404) {
        const q = await remote.get(cfg, "/v1/changes?limit=500", { timeoutMs: 6000 });
        if (!q.ok || !q.json || !Array.isArray(q.json.changes)) return null;
        const seen = new Set();
        agents = [];
        for (const c of q.json.changes) {
          if (!c || c.type !== "agent" || c.change === "D") continue;
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          agents.push({ id: c.id, title: c.title || "" });
        }
      } else {
        return null;
      }
    } else {
      const nodesDir = cfg.nodesDir();
      if (!fs.existsSync(nodesDir)) return null;
      const graphLib = require(path.join(ROOT, "lib", "graph.js"));
      const g = graphLib.loadGraph(nodesDir);
      agents = Object.values(g.nodes || {}).filter((n) => n.type === "agent");
    }
    const hits = agents.filter(isMatch).filter((a) => isAgentId(a.id));
    if (!hits.length) return null;
    if (hits.length > 1) return { ambiguous: [...new Set(hits.map((a) => a.id))] };
    return { id: hits[0].id };
  } catch {
    return null;
  }
}

// `spor agent use <agent-id>` — make this agent the machine's default dispatch
// identity by writing `dispatch.agent` to the USER config.json (the same
// machine-local, never-committed file as the repo map; per-machine, like
// dispatch.repos). This is the real setter the create/list hints point to;
// before it, dispatch.agent was settable only via env or by hand-editing the
// config. `spor agent use --clear` (or an empty id) drops the machine's agent
// identity — a remote dispatch then hard-fails unless --allow-person-token is
// also set. Not a graph write — purely local config, so it works in both modes.
async function cmdAgentUse(cfg, { id }) {
  const clear = id === "--clear" || id === "none" || id === "";
  if (!id) {
    err("usage: spor agent use <agent-id>   (or: spor agent use --clear)");
    return 1;
  }
  let resolvedId = id;
  let fromLabel = false;
  if (!clear && !isAgentId(id)) {
    const resolved = await resolveAgentIdFromLabel(cfg, id);
    if (resolved && resolved.ambiguous) {
      err(`'${id}' matches more than one of your agents: ${resolved.ambiguous.join(", ")} — pass the full agent id.`);
      return 1;
    }
    if (resolved && resolved.id) {
      resolvedId = resolved.id;
      fromLabel = true;
    } else {
      err(`invalid agent id '${id}' — must be an 'agent-<slug>' kebab id (e.g. agent-your-machine)`);
      const guess = agentIdGuess(id);
      if (guess) err(`  did you mean '${guess}'?  ('spor agent list' shows the full id — the 'agent-' prefix is part of it, not the label)`);
      return 1;
    }
  }
  const home = cfg.userConfigHome();
  const wrote = u.setDispatchAgent(home, clear ? null : resolvedId);
  const labelNote = fromLabel ? ` (resolved from label '${id}')` : "";
  if (clear) {
    out(wrote ? "cleared dispatch.agent — a remote dispatch now hard-fails unless --allow-person-token is set" : "dispatch.agent was already unset");
    return 0;
  }
  if (wrote) {
    out(`dispatch.agent = ${resolvedId}${labelNote}  (this machine now dispatches as ${resolvedId}; ${path.join(home, "config.json")})`);
  } else {
    out(`dispatch.agent already = ${resolvedId}${labelNote} (no change)`);
  }
  out("  attribution is remote-only; override one dispatch with: spor dispatch --as <agent-id>");
  return 0;
}

// Create an agent on the team server. By DEFAULT this is the SELF-SERVE POST
// /v1/agents — the agent is owned by the caller's bound person, no admin needed
// (task-spor-app-agents-self-serve-create). Passing --owner <person-x> creates
// on behalf of ANOTHER person, which is the admin twin POST /v1/admin/agents
// (admin-gated). Both routes share the server's createAgentNode body, so the 201
// shape ({id, owner, spiffe, …}) and the conflict/validation errors are
// identical — only the door and the 403 explanation differ.
async function cmdAgentCreateRemote(cfg, { label, owner, pubkey }) {
  const onBehalf = !!owner; // --owner names someone other than the caller
  const apiPath = onBehalf ? "/v1/admin/agents" : "/v1/agents";
  const body = { label };
  if (owner) body.owner = owner;
  if (pubkey) body.pubkey = pubkey;
  const r = await remote.post(cfg, apiPath, body);
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (r.status === 403) {
    // Self-serve: a 403 means an unbound caller (no person node to own it) — the
    // notBoundHint nudge. Admin (--owner): a 403 means the caller isn't an admin.
    if (onBehalf) { notAdminHint(r); }
    else {
      err("forbidden — creating an agent needs a bound person identity to own it.");
      err("your token maps to no person node; check 'spor whoami' (bound).");
    }
    return 1;
  }
  if (r.status === 404) {
    // An older server lacks the self-serve (or admin) creation route. Fail soft.
    err(`this server has no agent-creation endpoint yet (POST ${apiPath}).`);
    err("  upgrade the Spor server, or create the agent in local mode against a checkout.");
    return 1;
  }
  if (r.status === 409) {
    err(`agent already exists: ${(r.json && r.json.error && r.json.error.message) || "duplicate id"}`);
    return 1;
  }
  if (!r.ok) {
    err(`agent create failed (${r.status}): ${(r.json && r.json.error && r.json.error.message) || r.text}`);
    return 1;
  }
  const j = r.json || {};
  const id = j.id || `agent-${kebab(label)}`;
  out(`created agent ${id}${j.owner ? ` owned by ${labelledPerson(j.owner_name, j.owner)}` : ""}`);
  if (j.spiffe) out(`  spiffe: ${j.spiffe}`);
  out(`  make it this machine's default: spor agent use ${id}`);
  out(`  mint its standing PAT (SPOR_TOKEN for a headless agent): spor agent token ${id}`);
  return 0;
}

// Build the agent node + owned-by edge locally. Owner defaults to a single
// person node in the graph when unambiguous (the solo-local common case),
// else it must be named — the binding is identity-load-bearing, never guessed.
async function cmdAgentCreateLocal(cfg, { label, owner, pubkey }) {
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  const nodesDir = cfg.nodesDir();
  if (!fs.existsSync(nodesDir)) {
    err(`no graph at ${nodesDir} — run 'spor init' first`);
    return 1;
  }
  let g;
  try {
    g = graphLib.loadGraph(nodesDir);
  } catch (e) {
    err(`could not load graph: ${e.message}`);
    return 1;
  }
  let ownerId = owner;
  if (!ownerId) {
    const people = Object.values(g.nodes || {}).filter((n) => n.type === "person");
    if (people.length === 1) {
      ownerId = people[0].id;
    } else if (people.length === 0) {
      err("no person node in the graph to own this agent — pass --owner person-x");
      err("  (an agent's owner is recorded as an owned-by edge to a person node).");
      return 1;
    } else {
      err(`several person nodes — name the owner with --owner (one of: ${people.map((p) => `${personDisplayName(p, p.id)}=${p.id}`).slice(0, 6).join(", ")}${people.length > 6 ? ", …" : ""})`);
      return 1;
    }
  } else if (!(g.nodes && g.nodes[ownerId])) {
    err(`no such person node: ${ownerId}`);
    return 1;
  }

  const prefix = (g.registry && g.registry.prefixesFor("agent") || ["agent-"])[0] || "agent-";
  const id = `${prefix}${kebab(label)}`;
  if (fs.existsSync(path.join(nodesDir, `${id}.md`))) {
    err(`agent already exists: ${id}`);
    return 1;
  }
  // Forward-compat spiffe shape (dec-cc-spiffe-forward-compat): recorded, not
  // verified. <org> from config (default "local") so a solo graph is sensible.
  const org = cfg.get("org", null) || "local";
  const personLabel = ownerId.replace(/^person-/, "") || ownerId;
  const ownerName = personLabelFromGraph(g, ownerId);
  const spiffe = `spiffe://spor.${org}/person/${personLabel}/agent/${kebab(label)}`;
  const md =
    `---\nid: ${id}\ntype: agent\ntitle: ${label.replace(/\n/g, " ")}\n` +
    `summary: Automation principal ${label}, owned by ${ownerId} — its dispatched-session writes read "agent on behalf of person".\n` +
    `spiffe: ${spiffe}\npubkey: ${pubkey.replace(/\n/g, " ")}\nstatus: active\ndate: ${today()}\n` +
    `edges:\n  - {type: owned-by, to: ${ownerId}}\n---\n\n` +
    `Person-owned automation principal (dec-spor-agent-identity-nodes). Created by \`spor agent create\`; reused across dispatches as this machine's durable identity.\n`;
  let node;
  try {
    node = graphLib.parseFrontmatter(md, `${id}.md`);
  } catch (e) {
    err(`invalid node: ${e.message}`);
    return 1;
  }
  const v = graphLib.validateNode(g, node);
  if (!v.ok) {
    err(`invalid agent node:\n  ${v.errors.join("\n  ")}`);
    return 1;
  }
  fs.writeFileSync(path.join(nodesDir, `${id}.md`), md);
  out(`created agent ${id} owned by ${labelledPerson(ownerName, ownerId)}`);
  out(`  spiffe: ${spiffe}`);
  out(`  make it this machine's default: spor agent use ${id}`);
  out(`  (note: agent-on-behalf-of attribution applies in remote mode)`);
  return 0;
}

// List agent nodes. Remote: GET /v1/agents (the caller's owned agents — the
// dedicated route). If that surface isn't deployed (404), fall back to projecting
// the /v1/changes audit trail and keeping the type:agent rows (newest change per
// node first, so the first row per id is the live one). Local: scan the graph
// home. Fail-soft on any read error.
async function cmdAgentListRemote(cfg) {
  const a = await remote.get(cfg, "/v1/agents", { timeoutMs: 6000 });
  if (a.transport) {
    err(`offline — could not reach server (${a.error})`);
    return 1;
  }
  if (a.ok && a.json && Array.isArray(a.json.agents)) {
    const rows = a.json.agents.map((ag) => `${ag.id}\t${ag.owner ? `owned-by ${labelledPerson(ag.owner_name, ag.owner)}` : (ag.title || "")}\t${ag.status || "active"}`);
    if (!rows.length) {
      out("no agents yet — create one with 'spor agent create <label>'");
      return 0;
    }
    rows.forEach((l) => out(l));
    return 0;
  }
  // /v1/agents not deployed yet — degrade to the audit-trail projection, which
  // every remote client already has.
  if (a.status === 404) {
    const q = await remote.get(cfg, "/v1/changes?limit=500", { timeoutMs: 6000 });
    if (q.ok && q.json && Array.isArray(q.json.changes)) {
      const seen = new Set();
      const rows = [];
      for (const c of q.json.changes) {
        if (!c || c.type !== "agent" || c.change === "D") continue; // raw git --name-status letter (A/M/D), as the server emits
        if (seen.has(c.id)) continue; // first (newest) wins
        seen.add(c.id);
        rows.push(`${c.id}\t${c.title || ""}`);
      }
      if (!rows.length) {
        out("no agents yet — create one with 'spor agent create <label>'");
        return 0;
      }
      rows.forEach((l) => out(l));
      return 0;
    }
  }
  err("could not list agents from this server (no /v1/agents or /v1/changes route).");
  err("  list them in local mode against a checkout, or upgrade the server.");
  return 1;
}

function cmdAgentListLocal(cfg) {
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  const nodesDir = cfg.nodesDir();
  if (!fs.existsSync(nodesDir)) {
    err(`no graph at ${nodesDir} — run 'spor init' first`);
    return 1;
  }
  let g;
  try {
    g = graphLib.loadGraph(nodesDir);
  } catch (e) {
    err(`could not load graph: ${e.message}`);
    return 1;
  }
  const agents = Object.values(g.nodes || {}).filter((n) => n.type === "agent");
  if (!agents.length) {
    out("no agents yet — create one with 'spor agent create <label>'");
    return 0;
  }
  for (const a of agents.sort((x, y) => x.id.localeCompare(y.id))) {
    const ownedBy = (a.edges || []).find((e) => e.type === "owned-by");
    const status = a.status || "active";
    out(`${a.id}\t${ownedBy ? `owned-by ${labelledPerson(personLabelFromGraph(g, ownedBy.to), ownedBy.to)}` : "(no owner)"}\t${status}`);
  }
  return 0;
}

// --- spor agent token: standing agent-scoped PATs (over /v1/agents/<id>/token) -
// task-spor-cli-agent-self-serve-verbs: the CLI front-door for the Claude Code
// on the Web flow — create an agent, mint its standing PAT, set it as SPOR_TOKEN.
// A standing PAT is a long-lived agent-scoped spor_pat_ (the STANDING mode of
// POST /v1/agents/<id>/token, {standing:true} — task-spor-app-standing-agent-pat):
// same agent-on-behalf-of-owner attribution as a per-session dispatch token, but
// the 7d session cap lifts to a 1y PAT cap (user-set via --expires, rejected not
// clamped), listable and revocable as a durable credential. Authorization is
// OWNERSHIP — the agent's owner mints/lists/revokes its tokens, no admin. Remote
// only: the server is the token store. Mirrors the `spor token` self-serve verbs.
async function cmdAgentToken(cfg, args) {
  if (cfg.mode() !== "remote") {
    err("agent token needs a team graph (remote mode).");
    return 1;
  }
  const agent = args[0];
  if (!agent || agent.startsWith("-")) {
    err("usage: spor agent token <agent-id> [--expires <Nd>] [--label <l>]   mint a standing PAT");
    err("       spor agent token <agent-id> list                            its standing PATs");
    err("       spor agent token <agent-id> revoke <hash-prefix>            revoke one");
    return 1;
  }
  // The agent id must satisfy the server's mint contract EXACTLY (an `agent-`
  // kebab slug) — the same predicate `spor agent use`/`dispatch --as` enforce, so
  // a label-vs-id slip is caught here with the prefix nudge, never a server 422.
  if (!isAgentId(agent)) {
    err(`invalid agent id '${agent}' — must be an 'agent-<slug>' kebab id (e.g. agent-your-machine)`);
    const guess = agentIdGuess(agent);
    if (guess) err(`  did you mean '${guess}'?  ('spor agent list' shows the full id — the 'agent-' prefix is part of it, not the label)`);
    return 1;
  }
  const sub = args[1];
  if (sub === "list") return cmdAgentTokenList(cfg, agent);
  if (sub === "revoke") return cmdAgentTokenRevoke(cfg, agent, args.slice(2));
  return cmdAgentTokenMint(cfg, agent, args.slice(1));
}

// POST /v1/agents/{id}/token {standing:true, expires?, label?} — mint a standing
// agent PAT, returned in plaintext ONCE. Default + max expiry is 1 year
// (server-enforced, rejected not clamped); --expires shortens it (`<N>d` or an
// ISO date); --label tags it for the listing. An OLD server without standing mode
// still has the route but IGNORES `standing` and mints a SHORT per-session token —
// detect that (no `standing:true` echoed back) and say so, never present a 7d
// token as the durable SPOR_TOKEN the caller asked for.
async function cmdAgentTokenMint(cfg, agent, args) {
  const expires = optVal(args, "expires");
  const label = optVal(args, "label");
  const body = { standing: true, ...(expires ? { expires } : {}), ...(label ? { label } : {}) };
  const r = await remote.post(cfg, `/v1/agents/${encodeURIComponent(agent)}/token`, body, { timeoutMs: 6000 });
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (r.status === 403) {
    err(`forbidden — only the owner of ${agent} may mint its tokens.`);
    err(`  check it exists and you own it: spor agent list`);
    return 1;
  }
  if (r.status === 404) {
    err(`no such agent '${agent}' — list yours with 'spor agent list', or create it: spor agent create <label>`);
    return 1;
  }
  if (!r.ok) {
    err(`mint failed (${r.status}): ${(r.json && r.json.error && r.json.error.message) || r.text}`);
    return 1;
  }
  const j = r.json || {};
  if (j.standing !== true) {
    // The route exists but the server didn't honor standing mode (pre-standing-PAT
    // build): it minted a short per-session token instead. Surface it — it works as
    // SPOR_TOKEN until it ages out — but be honest that it is not durable.
    err("warning: this server has no standing-PAT support yet — it minted a SHORT");
    err(`  per-session token${j.expires_at ? ` (expires ${j.expires_at})` : ""}, not a 1-year standing PAT. Upgrade the server.`);
    if (j.token) out(j.token);
    return 1;
  }
  out(`minted standing PAT for ${j.agent || agent}${j.owner ? ` (owned by ${labelledPerson(j.owner_name, j.owner)})` : ""}${j.label ? ` [${j.label}]` : ""}${j.expires ? ` (expires ${j.expires})` : ""} [${j.hash_prefix}]`);
  out(`  this is shown ONCE — copy it now, it is not recoverable:\n`);
  out(`  ${j.token}\n`);
  out(`  set it as SPOR_TOKEN for a headless agent (e.g. Claude Code on the Web).`);
  out(`  revoke later with: spor agent token ${j.agent || agent} revoke ${j.hash_prefix}`);
  return 0;
}

// GET /v1/agents/{id}/tokens — list this agent's STANDING PATs (short per-session
// dispatch tokens are excluded server-side; they age out on their own).
async function cmdAgentTokenList(cfg, agent) {
  const r = await remote.get(cfg, `/v1/agents/${encodeURIComponent(agent)}/tokens`, { timeoutMs: 6000 });
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (r.status === 403) {
    err(`forbidden — only the owner of ${agent} may manage its standing tokens.`);
    return 1;
  }
  if (r.status === 404) {
    err(`no such agent '${agent}' (or this server has no standing-PAT endpoint yet).`);
    return 1;
  }
  if (!r.ok) {
    err(`error ${r.status}`);
    return 1;
  }
  const toks = (r.json && r.json.tokens) || [];
  if (!toks.length) {
    out(`no standing PATs for ${agent} — mint one with 'spor agent token ${agent}'`);
    return 0;
  }
  for (const t of toks) {
    out(`${t.hash_prefix}  ${t.label || "(no label)"}${t.expired ? "  EXPIRED" : ""}${t.expires ? `  (expires ${t.expires})` : ""}`);
  }
  return 0;
}

// DELETE /v1/agents/{id}/tokens/{prefix} — revoke one of this agent's standing
// PATs by hash prefix; a prefix that isn't one is a 404 (never a session token or
// another agent's PAT). Revocable per-environment without touching the owner's
// other access.
async function cmdAgentTokenRevoke(cfg, agent, args) {
  const prefix = args.find((a) => !a.startsWith("-"));
  if (!prefix) {
    err(`usage: spor agent token ${agent} revoke <hash-prefix>`);
    return 1;
  }
  const r = await remote.del(cfg, `/v1/agents/${encodeURIComponent(agent)}/tokens/${encodeURIComponent(prefix)}`, { timeoutMs: 6000 });
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (r.status === 403) {
    err(`forbidden — only the owner of ${agent} may manage its standing tokens.`);
    return 1;
  }
  if (r.status === 404) {
    err(`no standing PAT of ${agent} matches '${prefix}' (list them: spor agent token ${agent} list).`);
    return 1;
  }
  if (!r.ok) {
    err(`revoke failed (${r.status}): ${(r.json && r.json.error && r.json.error.message) || r.text}`);
    return 1;
  }
  out(`revoked ${r.json.hash_prefix}${r.json.oauth_grants_revoked ? ` (+${r.json.oauth_grants_revoked} oauth grants)` : ""}`);
  return 0;
}

// --- spor token: self-serve personal access tokens (over /v1/me/tokens) ----
// task-spor-cli-me-tokens-verbs: the CLI twin of task-spor-app-me-tokens-self-
// serve, following the `spor agent` self-serve precedent. By DEFAULT every verb
// is caller-scoped over /v1/me/tokens — you create, list, and revoke your OWN
// personal access tokens (spor_pat_, for CI and headless use) with no admin
// privilege. `--all` escalates list/revoke to the team-wide admin view
// (/v1/admin/tokens, admin-gated), which `spor admin token` reaches by the same
// path. Remote-only — the server is the token store.
//
// A personal access token needs a BOUND person identity (you need a person node
// to own it); an unbound caller (a legacy by-value or OAuth token mapping to no
// person node) is a 403 the server explains, relayed here with a 'spor whoami'
// nudge — the self-serve sibling of notAdminHint.
function notBoundHint(r) {
  if (r.status === 403) {
    err("forbidden — a personal access token needs a bound person identity.");
    err("your token maps to no person node; check 'spor whoami' (bound).");
    return true;
  }
  return false;
}

async function cmdToken(cfg, args) {
  if (cfg.mode() !== "remote") {
    err("token needs a team graph (remote mode).");
    return 1;
  }
  const all = args.includes("--all");
  const sub = args[0];
  if (sub === "create") return cmdTokenCreate(cfg, args);
  if (sub === "list") return all ? cmdTokenListAdmin(cfg) : cmdTokenListSelf(cfg);
  if (sub === "revoke") return all ? cmdTokenRevokeAdmin(cfg, args) : cmdTokenRevokeSelf(cfg, args);
  err("usage: spor token create [--expires <Nd>] [--label <l>]   mint your own PAT");
  err("       spor token list [--all]                            your PATs (--all: team, admin)");
  err("       spor token revoke <hash-prefix> [--all]            revoke one (--all: team, admin)");
  return 1;
}

// POST /v1/me/tokens {expires?, label?} — mint a caller-scoped PAT, returned in
// plaintext ONCE. Default + max expiry is 1 year (server-enforced); --expires
// shortens it (`<N>d` or an ISO date); --label tags it for the listing.
async function cmdTokenCreate(cfg, args) {
  const expires = optVal(args, "expires");
  const label = optVal(args, "label");
  const body = { ...(expires ? { expires } : {}), ...(label ? { label } : {}) };
  const r = await remote.post(cfg, "/v1/me/tokens", body);
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (notBoundHint(r)) return 1;
  if (!r.ok) {
    err(`mint failed (${r.status}): ${(r.json && r.json.error && r.json.error.message) || r.text}`);
    return 1;
  }
  const j = r.json;
  out(`minted personal access token for ${labelledPerson(j.name, j.person)}${j.email ? ` <${j.email}>` : ""}${j.label ? ` [${j.label}]` : ""}${j.expires ? ` (expires ${j.expires})` : ""} [${j.hash_prefix}]`);
  out(`  this is shown ONCE — copy it now, it is not recoverable:\n`);
  out(`  ${j.token}\n`);
  out(`  use it as SPOR_TOKEN, or run: spor join ${remote.base(cfg)} ${j.token}`);
  out(`  revoke later with: spor token revoke ${j.hash_prefix}`);
  return 0;
}

// GET /v1/me/tokens — list the caller's OWN PATs (agent session tokens excluded
// server-side). person/email are always the caller here, so the label leads.
async function cmdTokenListSelf(cfg) {
  const r = await remote.get(cfg, "/v1/me/tokens");
  if (r.transport) {
    err(`offline (${r.error})`);
    return 1;
  }
  if (notBoundHint(r)) return 1;
  if (!r.ok) {
    err(`error ${r.status}`);
    return 1;
  }
  const toks = (r.json && r.json.tokens) || [];
  if (!toks.length) {
    out("no personal access tokens — mint one with 'spor token create'");
    return 0;
  }
  for (const t of toks) {
    out(`${t.hash_prefix}  ${t.label || "(no label)"}${t.expired ? "  EXPIRED" : ""}${t.expires ? `  (expires ${t.expires})` : ""}`);
  }
  return 0;
}

// DELETE /v1/me/tokens/{prefix} — revoke one of the caller's OWN PATs; a prefix
// that isn't theirs is a 404 (never another person's token).
async function cmdTokenRevokeSelf(cfg, args) {
  const prefix = args.slice(1).find((a) => !a.startsWith("-"));
  if (!prefix) {
    err("usage: spor token revoke <hash-prefix>");
    return 1;
  }
  const r = await remote.del(cfg, `/v1/me/tokens/${encodeURIComponent(prefix)}`);
  if (r.transport) {
    err(`offline (${r.error})`);
    return 1;
  }
  if (notBoundHint(r)) return 1;
  if (r.status === 404) {
    err(`no personal access token of yours matches '${prefix}' (team view: 'spor token revoke ${prefix} --all').`);
    return 1;
  }
  if (!r.ok) {
    err(`revoke failed (${r.status}): ${(r.json && r.json.error && r.json.error.message) || r.text}`);
    return 1;
  }
  out(`revoked ${r.json.hash_prefix}${r.json.oauth_grants_revoked ? ` (+${r.json.oauth_grants_revoked} oauth grants)` : ""}`);
  return 0;
}

// GET /v1/admin/tokens — the team-wide view (admin-gated). The escalated arm of
// `spor token list --all` and the body of `spor admin token list`.
async function cmdTokenListAdmin(cfg) {
  const r = await remote.get(cfg, "/v1/admin/tokens");
  if (r.transport) {
    err(`offline (${r.error})`);
    return 1;
  }
  if (notAdminHint(r)) return 1;
  if (!r.ok) {
    err(`error ${r.status}`);
    return 1;
  }
  const toks = (r.json && r.json.tokens) || [];
  if (!toks.length) {
    out("no tokens");
    return 0;
  }
  for (const t of toks) {
    out(`${t.hash_prefix}  ${labelledPerson(t.name, t.person) || t.email || "?"}${t.expired ? "  EXPIRED" : ""}${t.expires ? `  (expires ${t.expires})` : ""}`);
  }
  return 0;
}

// DELETE /v1/admin/tokens/{prefix} — revoke ANY token by prefix (admin-gated).
// The escalated arm of `spor token revoke <prefix> --all` and `spor admin token
// revoke <prefix>`.
async function cmdTokenRevokeAdmin(cfg, args) {
  const prefix = args.slice(1).find((a) => !a.startsWith("-"));
  if (!prefix) {
    err("usage: spor token revoke <hash-prefix> --all   (or: spor admin token revoke <hash-prefix>)");
    return 1;
  }
  const r = await remote.del(cfg, `/v1/admin/tokens/${encodeURIComponent(prefix)}`);
  if (r.transport) {
    err(`offline (${r.error})`);
    return 1;
  }
  if (notAdminHint(r)) return 1;
  if (!r.ok) {
    err(`revoke failed (${r.status}): ${(r.json && r.json.error && r.json.error.message) || r.text}`);
    return 1;
  }
  out(`revoked ${r.json.hash_prefix}${r.json.oauth_grants_revoked ? ` (+${r.json.oauth_grants_revoked} oauth grants)` : ""}`);
  return 0;
}

// --- spor admin: the ops-facing operations surface ------------------------
// A parent verb for ops-facing operations kept APART from everyday graph work
// (the task's framing: the home for stewards-gated ops, alongside IDP management
// and the like). Today it dispatches one sub-command — `gardener`, the on-demand
// gardener sweep. REMOTE only: the server owns these operations; local mode has
// no server-side sweep to trigger.
async function cmdAdmin(cfg, args) {
  const sub = args[0];
  if (sub === "gardener") return cmdAdminGardener(cfg, args.slice(1));
  if (sub === "token") return cmdAdminToken(cfg, args.slice(1));
  if (sub) err(`spor admin: unknown sub-command '${sub}'.`);
  err("usage: spor admin gardener [--json]");
  err("       spor admin token list | spor admin token revoke <hash-prefix>");
  return 1;
}

// spor admin token list|revoke — the team-wide token surface under the ops
// parent (the discoverable home for the `--all` escalation of `spor token`).
// Remote + admin only; delegates to the shared admin list/revoke arms.
async function cmdAdminToken(cfg, args) {
  if (cfg.mode() !== "remote") {
    err("token admin needs a team graph (remote mode).");
    return 1;
  }
  const sub = args[0];
  if (sub === "list") return cmdTokenListAdmin(cfg);
  if (sub === "revoke") return cmdTokenRevokeAdmin(cfg, args);
  err("usage: spor admin token list | spor admin token revoke <hash-prefix>");
  return 1;
}

// spor admin gardener — run a gardener sweep now (POST /v1/gardener, QUEUE.md
// §6). The server-side sweep files its observations as ordinary `type: finding`
// queue items (dec-cc-gardener-files-findings) and resolves its OWN findings
// whose condition has since cleared — it never mutates human-authored nodes. The
// response is { checked, filed: [...ids], resolved: [...ids], skipped: [...ids],
// generated_at }; `filed`/`resolved` are the actionable ids, `skipped` is mostly
// idempotent re-detections (a "REJECTED" entry there is a gardener bug). REMOTE
// only — the gardener runs on the server; a sweep can examine the whole graph, so
// the request gets a generous timeout. The endpoint is authenticated but NOT
// admin-gated server-side today (any valid team token can trigger it); the 403
// handling below is forward-compat for a deployment that adds the stewards→root
// gate — the task's stewards-gated intent, which is a coordinated server change.
async function cmdAdminGardener(cfg, args) {
  if (cfg.mode() !== "remote") {
    err("admin gardener needs a team graph (remote mode) — the server runs the sweep.");
    return 1;
  }
  const json = args.includes("--json");
  const r = await remote.post(cfg, "/v1/gardener", {}, { timeoutMs: 120000 });
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (notAdminHint(r)) return 1;
  if (!r.ok) {
    err(`gardener sweep failed (${r.status}): ${(r.json && r.json.error && r.json.error.message) || r.text}`);
    return 1;
  }
  if (json) {
    out(JSON.stringify(r.json, null, 2));
    return 0;
  }
  const j = r.json || {};
  const filed = Array.isArray(j.filed) ? j.filed : [];
  const resolved = Array.isArray(j.resolved) ? j.resolved : [];
  const skipped = Array.isArray(j.skipped) ? j.skipped : [];
  const checked = typeof j.checked === "number" ? j.checked : 0;
  // skipped is mostly already-open findings (idempotent re-detection); only a
  // "REJECTED" entry there is worth surfacing — it means the sweep dropped a
  // finding its own validator rejected (a gardener bug), not a quiet no-op.
  const rejected = skipped.filter((s) => typeof s === "string" && s.includes("REJECTED"));
  out(`gardener swept ${checked} node${checked === 1 ? "" : "s"}: ${filed.length} filed, ${resolved.length} resolved, ${skipped.length} unchanged`);
  for (const id of filed) out(`  filed     ${id}`);
  for (const id of resolved) out(`  resolved  ${id}`);
  if (!filed.length && !resolved.length) out("  no new findings filed or resolved this sweep");
  for (const s of rejected) err(`  REJECTED (gardener bug): ${s}`);
  return 0;
}

function safeSlug() {
  try {
    return u.projectSlug(process.cwd());
  } catch {
    return path.basename(process.cwd()) || "project";
  }
}

// The git toplevel of the cwd, or cwd itself — where repo-scoped files live.
// Worktree-local on purpose: cmdScope/cmdLink/targetPath write committable
// files (.spor.json, .spor, repo-scoped hook config) into the user's CURRENT
// checkout, so a linked worktree keeps its own dir, not the main one.
function repoRoot() {
  const r = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const top = (r.stdout || "").trim();
  return top || process.cwd();
}

// The DURABLE repo root for dispatch: like repoRoot(), but inside a linked git
// worktree it resolves to the MAIN checkout (dirname --git-common-dir), not the
// ephemeral worktree dir. dispatch persists this dir into the machine-local
// dispatch.repos slug->path map, so stamping a worktree path would leave a dead
// mapping the instant the worktree is removed
// (issue-spor-dispatch-worktree-dir-stamping). This is the same inferenceRoot()
// session-start already registers with, so the slug (safeSlug -> projectSlug)
// and the path stay consistent. Byte-identical to repoRoot() outside a worktree.
function dispatchRoot() {
  return u.inferenceRoot(process.cwd()) || repoRoot();
}

// A git invocation inside a given working tree. Captures output so callers can
// branch on status/stderr; never throws (a missing git binary surfaces as
// r.error, handled by hasGit() before we get here). Env-scrubbed (gitSpawn,
// lib/shell/git-exec.js — the one definition shared with util.js's git() and
// gittime.js) so `cwd` — not an ambient GIT_DIR — names the repo
// (issue-spor-dispatch-worktree-wrong-repo-location).
function git(cwd, gitArgs, opts = {}) {
  return gitSpawn(cwd, gitArgs, opts);
}
function hasGit() {
  return !git(process.cwd(), ["--version"]).error;
}

// --- spor migrate / push: seed the local graph to a user-owned remote -------
// The solo-remote tier (dec-spor-solo-remote-entry-tier) has the HOSTED server
// READ a remote graph repo the user owns; migrate is the client side that gets
// ~/.spor there — pure git plumbing against the graph home. There is no server
// route for BYO-repo registration, and the GitHub-App write grant of
// dec-spor-solo-remote-write-credential-custody is unbuilt server-side; both
// are tracked separately, so this verb stops at "your graph is on your remote".
function cmdMigrate(cfg, { positionals }) {
  const home = cfg.graphHome();
  const nodesDir = cfg.nodesDir();
  if (!fs.existsSync(nodesDir)) {
    err(`no graph at ${nodesDir} — run 'spor init' first`);
    return 1;
  }
  if (!hasGit()) {
    err("git not found — migrate needs git on PATH");
    return 1;
  }
  // 1. ensure the graph home is a git repo (idempotent, like cmdInit).
  if (!fs.existsSync(path.join(home, ".git"))) {
    const r = git(home, ["init", "-q"]);
    if (r.status !== 0) {
      err(`git init failed: ${(r.stderr || "").trim() || "unknown error"}`);
      return 1;
    }
  }
  // 2. commit any pending graph state so there is something to push.
  git(home, ["add", "-A"]);
  const dirty = (git(home, ["status", "--porcelain"]).stdout || "").trim();
  const hasCommit = git(home, ["rev-parse", "--verify", "-q", "HEAD"]).status === 0;
  if (dirty || !hasCommit) {
    let c = git(home, [...u.NO_GPGSIGN, "commit", "-q", "-m", "spor: graph snapshot"]);
    // No git identity configured in this environment — fall back so the
    // housekeeping commit still lands. The user's own identity is preferred
    // whenever git has one; this only fires when it has none.
    if (c.status !== 0 && /identity|user\.(email|name)|empty ident/i.test(c.stderr || "")) {
      c = git(home, [...u.NO_GPGSIGN, "-c", "user.email=spor@localhost", "-c", "user.name=spor", "commit", "-q", "-m", "spor: graph snapshot"]);
    }
    if (c.status !== 0) {
      err(`could not commit the graph: ${(c.stderr || "").trim() || "nothing to commit"}`);
      return 1;
    }
  }
  // 3. wire the remote. An explicit URL sets/updates origin; otherwise reuse an
  //    existing origin, or explain that one is required.
  const url = positionals[0];
  const haveOrigin = git(home, ["remote", "get-url", "origin"]).status === 0;
  if (url) {
    const r = haveOrigin ? git(home, ["remote", "set-url", "origin", url]) : git(home, ["remote", "add", "origin", url]);
    if (r.status !== 0) {
      err(`could not set origin: ${(r.stderr || "").trim()}`);
      return 1;
    }
  } else if (!haveOrigin) {
    err("usage: spor migrate <remote-url>   (a git remote you own, e.g. git@github.com:you/my-graph.git)");
    err("  no 'origin' is configured on the graph yet — pass the URL once and it's remembered.");
    return 1;
  }
  const origin = (git(home, ["remote", "get-url", "origin"]).stdout || "").trim();
  // 4. push the current branch, setting upstream.
  const branch = (git(home, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "").trim() || "main";
  const p = git(home, ["push", "-u", "origin", branch]);
  if (p.status !== 0) {
    err(`push to ${origin} failed: ${(p.stderr || "").trim() || "unknown error"}`);
    err("  check the remote exists and your credentials/SSH key can write to it.");
    return 1;
  }
  out(`pushed ${nodeCount(nodesDir) ?? 0} nodes (${branch}) to ${origin}`);
  out(`  next: point a hosted Spor server at this remote, then 'spor join <server> <token>'.`);
  return 0;
}

// --- spor enable / disable: per-repo scoping (stops side-project pollution) --
// Merge { enabled } into the repo's committable .spor.json without hand-editing.
function cmdScope(enabled) {
  const root = repoRoot();
  const file = path.join(root, ".spor.json");
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    /* absent or malformed — start fresh */
  }
  data.enabled = enabled;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  out(`${enabled ? "enabled" : "disabled"} Spor for ${root}`);
  out(`  ${file} — hooks are now ${enabled ? "active" : "a no-op"} here; commit it to share the setting`);
  return 0;
}

// --- spor link <slug>: write the .spor identity marker --------------------
// Fixes a wrong inferred slug (basename != canonical) deterministically,
// instead of waiting for the server's fingerprint-alias proposal to be approved.
function cmdLink(cfg, { positionals }) {
  const slug = positionals[0] || safeSlug();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    err(`invalid slug '${slug}' — must match ^[a-z0-9][a-z0-9-]*$`);
    return 1;
  }
  const root = repoRoot();
  const file = path.join(root, ".spor");
  let lines = [];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    /* absent */
  }
  const kept = lines.filter((l) => l.trim() && !/^repo:/.test(l));
  fs.writeFileSync(file, [`repo: ${slug}`, ...kept].join("\n") + "\n");
  out(`linked ${root} to repo: ${slug}`);
  out(`  ${file} — commit it so every checkout shares this identity`);
  return 0;
}

// --- spor agents-md: committed capture-discipline directive ----------------
// (task-spor-agents-md-capture-discipline-directive) Write/refresh the managed
// AGENTS.md block with the standing user-voice directive to keep the graph
// current. The 2026-07 retrospective found front-loaded user-voice directives
// were the one condition that reliably produced unprompted capture (~8/8 vs a
// ~0-10% baseline), while the hook-injected preamble saying the same thing in
// system-reminder voice underperformed — so the directive belongs in a
// COMMITTED instructions file, where it reaches every contributor and every
// dispatched agent. Default is directive-only: hooked hosts already receive
// the briefing at session start, and a committed briefing snapshot stales;
// --briefing restores the full hook-less floor (directive + briefing embed).
async function cmdAgentsMd(cfg, { values }) {
  const root = repoRoot();
  const { writeAgentsBlock } = require(path.join(ROOT, "scripts", "engines", "agents-md.js"));
  const { file, meta } = await writeAgentsBlock({
    cwd: root,
    briefing: !!values.briefing,
    noServerLine: !!values["no-server-line"],
  });
  out(`updated ${file} (${values.briefing ? meta || "no briefing yet, MCP pointers only" : "capture-discipline directive"})`);
  // CLAUDE.md rides along via an @AGENTS.md import (Claude Code resolves
  // @-imports): if the repo has a CLAUDE.md that never mentions AGENTS.md,
  // Claude Code sessions would miss the directive entirely. Append the import
  // once; never CREATE a CLAUDE.md (AGENTS.md alone is the portable surface).
  if (!values["no-claude-md"]) {
    const claudeMd = path.join(root, "CLAUDE.md");
    if (fs.existsSync(claudeMd)) {
      const txt = fs.readFileSync(claudeMd, "utf8");
      if (!/AGENTS\.md/.test(txt)) {
        fs.writeFileSync(claudeMd, txt + (txt.endsWith("\n") ? "" : "\n") + "\n@AGENTS.md\n");
        out(`updated ${claudeMd} (@AGENTS.md import appended)`);
      }
    }
  }
  out("  commit the file(s) so every contributor and dispatched agent inherits the directive");
  return 0;
}

// `spor upgrade` rider: the committed directive tracks the packaged wording —
// refresh the current repo's managed block IF one exists, preserving whether
// it embedded a briefing. A repo that never opted into the block is untouched.
async function refreshAgentsBlockIfManaged(root = repoRoot()) {
  const file = path.join(root, "AGENTS.md");
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  if (!existing.includes("<!-- spor:begin -->") && !existing.includes("<!-- substrate:begin -->")) return;
  const { writeAgentsBlock } = require(path.join(ROOT, "scripts", "engines", "agents-md.js"));
  await writeAgentsBlock({ cwd: root, briefing: /### Standing project briefing/.test(existing) });
  out(`refreshed ${file} (managed Spor block — commit if the wording changed)`);
}

// --- spor install / setup: wire spor into a host agent ---------------------
// dec-cc-portable-core-adapters ships a manifest per host under adapters/<host>/
// with a __SPOR_ROOT__ placeholder; installing one resolves the placeholder to
// THIS checkout and drops/merges the manifest into the host's config location.
// Until now this was a manual sed/ln recipe in each adapter README — this verb
// is its automation. Claude Code is special: it has no flat hook file, so we
// shell out to its plugin CLI (this repo IS the marketplace) rather than
// hand-edit ~/.claude/settings.json, which the CLI owns.
const HOSTS = {
  claude: { kind: "claude", label: "Claude Code" },
  codex: {
    kind: "codex",
    label: "Codex CLI",
    src: ["adapters", "codex", "hooks.json"],
    user: [".codex", "hooks.json"],
    repo: [".codex", "hooks.json"],
    extras: [
      { kind: "codex-agent", src: ["agents", "backfill.md"], user: [".codex", "agents", "spor-backfill.toml"], repo: [".codex", "agents", "spor-backfill.toml"] },
    ],
  },
  cursor: { kind: "hooks", label: "Cursor", src: ["adapters", "cursor", "hooks.json"], user: [".cursor", "hooks.json"], repo: [".cursor", "hooks.json"] },
  copilot: { kind: "hooks", label: "GitHub Copilot CLI", src: ["adapters", "copilot", "spor.json"], user: [".copilot", "hooks", "spor.json"], repo: [".github", "hooks", "spor.json"] },
  gemini: { kind: "hooks", label: "Gemini CLI", src: ["adapters", "gemini", "hooks", "hooks.json"], user: [".gemini", "settings.json"], repo: [".gemini", "settings.json"] },
  opencode: { kind: "plugin", label: "OpenCode", src: ["adapters", "opencode", "spor.js"], user: [".config", "opencode", "plugins", "spor.js"], repo: [".opencode", "plugins", "spor.js"] },
};

// The config dir whose presence means a host is set up on this machine.
const HOST_PROBE = {
  codex: [".codex"],
  cursor: [".cursor"],
  copilot: [".copilot"],
  gemini: [".gemini"],
  opencode: [".config", "opencode"],
  claude: [".claude"],
};

// $HOME first so tests (and conventional overrides) win; os.homedir() is the
// cross-platform fallback (USERPROFILE on Windows).
function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

// The Claude Code binary, overridable for tests (a stub fed via SPOR_CLAUDE_CMD,
// same lever 'spor dispatch' uses) or by `dispatch.bin.claude-code` in the
// config cascade. `cfg` is optional so every existing bare call keeps resolving
// env-then-PATH exactly as before; pass it through wherever a Config is already
// in hand so a box configured only via the cascade (no env var) gets the SAME
// launcher for plugin management as `spor dispatch` already uses (these
// shell-outs used to skip the cascade entirely — task-spor-dispatch-adapter-
// follow-up-batch). All claude shell-outs route through here.
function claudeCmd(cfg = null) {
  return dispatchHarnesses.getHarness("claude-code").command(process.env, cfg);
}

// The Codex CLI binary, overridable for tests or `dispatch.bin.codex`, same
// cascade as claudeCmd() above. Codex owns plugin install state, so all plugin
// shell-outs route through this seam instead of writing its cache.
function codexCmd(cfg = null) {
  return dispatchHarnesses.getHarness("codex").command(process.env, cfg);
}

function spawnPortableSync(cmd, args, opts = {}) {
  if (process.platform !== "win32" || opts.shell) return spawnSync(cmd, args, opts);
  const resolved = u.whichSync(cmd) || cmd;
  if (/\.(?:cmd|bat)$/i.test(resolved)) {
    const { shell: _shell, ...rest } = opts;
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", resolved, ...args], rest);
  }
  return spawnSync(resolved, args, opts);
}

// The spor plugin Claude Code has LOADED (its own cached copy under
// ~/.claude/plugins/), parsed from `claude plugin list --json`, or null if the
// claude CLI is absent / spor isn't installed. Fail-soft and bounded — never
// throws, prints, or hangs — so it is safe to call on the status path.
function claudePluginInfo(cfg = null) {
  const cmd = claudeCmd(cfg);
  if (cmd === "claude" && !hasCmd("claude")) return null;
  const r = spawnPortableSync(cmd, ["plugin", "list", "--json"], { encoding: "utf8", timeout: 8000 });
  if (r.status !== 0 || !r.stdout) return null;
  let arr;
  try {
    arr = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const p = arr.find((x) => x && typeof x.id === "string" && x.id.split("@")[0] === "spor");
  return p ? { version: p.version, scope: p.scope, enabled: p.enabled, installPath: p.installPath } : null;
}

// Best-effort: is a claude.ai Spor MCP connector CURRENTLY bound on this box? A
// connector added in claude.ai surfaces in Claude Code as the mcp__…_Spor__*
// tools (art-cc-spor-connector-dual-host), i.e. a SECOND live write surface
// alongside the local file graph. We read the LIVE set from `claude mcp list`
// (mirroring claudePluginInfo's spawn) and look for a Spor-named connector —
// matching the pre-rename "Substrate" name too. We deliberately do NOT key on
// ~/.claude.json's `claudeAiMcpEverConnected`: that array is a sticky historical
// "ever connected" list that never clears when a connector is disabled or
// removed, so it warned forever after the user unbound the connector
// (issue-spor-status-split-brain-warning-false-positive). FAIL-OPEN by contract:
// claude absent / nonzero exit / timeout / empty output all return false, so
// `spor status` never emits a false split-brain warning or hangs. The health
// status (Connected / Needs authentication / Failed) is ignored — any current
// binding is a configured second write surface. SPOR_FAKE_MCP_LIST injects
// canned `claude mcp list` output for tests.
function sporConnectorBound(cfg = null) {
  try {
    let text = process.env.SPOR_FAKE_MCP_LIST;
    if (text == null) {
      const cmd = claudeCmd(cfg);
      if (cmd === "claude" && !hasCmd("claude")) return false;
      const r = spawnPortableSync(cmd, ["mcp", "list"], { encoding: "utf8", timeout: 8000 });
      if (r.status !== 0 || !r.stdout) return false;
      text = r.stdout;
    }
    // Each connector is a line like "claude.ai Spor: <url> - <status>". Match the
    // NAME segment (before the first colon) only, so a "spor" in a URL or status
    // can't trip it; \b keeps "Spotify"/"Supabase" from matching "spor".
    return text
      .split("\n")
      .some((line) => /\bspor\b|\bsubstrate\b/i.test(line.split(":")[0] || ""));
  } catch {
    return false; // claude missing, spawn error, or unparseable => assume none
  }
}

// The package's declared Node floor — the FIRST integer in package.json's
// engines.node range (">=20" => 20, ">=20.10.0" => 20, "20.x" => 20). The
// engines field is the contract (dec-spor-client-node20-floor); read it, never
// hardcode the number. Returns null if the field is absent/unparseable.
function nodeFloor() {
  let spec;
  try {
    const pkg = require(path.join(ROOT, "package.json"));
    spec = pkg && pkg.engines && pkg.engines.node;
  } catch {
    return null;
  }
  if (!spec) return null;
  const m = String(spec).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// Is the Node interpreter running this CLI new enough for the package floor?
// Detection lives HERE (install/status time), never in the hook — the prompt
// path stays fail-open (dec-cc-fail-open-hooks). bin/spor-hook short-circuits
// `command -v node || exit 0`, so a box with Claude Code but no/old Node sees
// every hook silently no-op (issue-spor-onboarding-no-node-silent-fail-open);
// this is the surface that explains it. Returns { running, floor, ok, line }:
// `ok` is true when the floor is satisfied (or unknown), `line` is a one-line
// status/prereq string suitable for `spor status` / `spor install`.
function nodeRuntimeCheck(running) {
  const ver = String(running == null ? process.versions.node : running);
  const floor = nodeFloor();
  const major = parseInt(ver.split(".")[0], 10);
  // Floor unknown (or our own version unparseable) => don't claim a problem.
  if (floor == null || !Number.isFinite(major)) {
    return { running: ver, floor, ok: true, line: `node:     ${ver}` };
  }
  const ok = major >= floor;
  const line = ok
    ? `node:     ${ver} (>= ${floor} required, OK)`
    : `node:     ${ver} — TOO OLD. Spor requires Node ${floor}+. Upgrade Node (e.g. via nvm or your package manager); on the old version every hook silently no-ops.`;
  return { running: ver, floor, ok, line };
}

// Compare two dot-numeric versions (a trailing -prerelease is ignored). -1/0/1.
function verCmp(a, b) {
  const parse = (v) => String(v).split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// The latest @sporhq/spor version published to the public npm registry, or null
// on any error/timeout/offline — a best-effort hint, never a hard dependency.
// SPOR_NO_NET skips the network; SPOR_NPM_LATEST overrides the answer (a test
// hook so the registry check is exercised without a network round-trip).
async function npmLatest(timeoutMs = 4000) {
  if (process.env.SPOR_NPM_LATEST) return process.env.SPOR_NPM_LATEST;
  if (process.env.SPOR_NO_NET) return null;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const req = https.get("https://registry.npmjs.org/@sporhq%2Fspor/latest", { headers: { accept: "application/json" } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return finish(null);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
          if (body.length > 1e6) req.destroy();
        });
        res.on("end", () => {
          try {
            finish(JSON.parse(body).version || null);
          } catch {
            finish(null);
          }
        });
      });
      req.on("error", () => finish(null));
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        finish(null);
      });
    } catch {
      finish(null);
    }
  });
}


function deepReplace(v, from, to) {
  if (typeof v === "string") return v.split(from).join(to);
  if (Array.isArray(v)) return v.map((x) => deepReplace(x, from, to));
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = deepReplace(v[k], from, to);
    return o;
  }
  return v;
}

// Parse the manifest template as JSON, THEN substitute the root into string
// values — so a Windows root with backslashes never has to survive JSON escaping.
function renderManifest(srcSegs) {
  const raw = fs.readFileSync(path.join(ROOT, ...srcSegs), "utf8");
  return deepReplace(JSON.parse(raw), "__SPOR_ROOT__", ROOT);
}

function readMarkdownAgent(srcSegs) {
  const raw = fs.readFileSync(path.join(ROOT, ...srcSegs), "utf8").replace(/\r\n/g, "\n");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  let body = raw;
  if (m) {
    body = m[2];
    for (const line of m[1].split("\n")) {
      const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (mm) meta[mm[1]] = mm[2].trim();
    }
  }
  return { meta, body: body.trim() + "\n" };
}

function tomlString(s) {
  return JSON.stringify(String(s));
}

function tomlMultilineString(s) {
  const text = String(s).replace(/\r\n/g, "\n").trimEnd();
  if (text.includes('"""')) return tomlString(text);
  return `"""\n${text}\n"""`;
}

function renderCodexAgent(srcSegs) {
  const { meta, body } = readMarkdownAgent(srcSegs);
  const name = meta.name || path.basename(srcSegs[srcSegs.length - 1], ".md");
  const description = meta.description || `Custom agent generated from ${srcSegs.join("/")}.`;
  return [
    `name = ${tomlString(name)}`,
    `description = ${tomlString(description)}`,
    `developer_instructions = ${tomlMultilineString(body)}`,
    "",
  ].join("\n");
}

// Merge our hooks.{event:[...]} into an existing host config without clobbering
// the user's own hooks or top-level keys. Idempotent: prior spor entries (any
// whose command mentions spor-hook) are dropped first, so re-install refreshes a
// stale __SPOR_ROOT__ path instead of duplicating.
function mergeHooks(existing, incoming) {
  const merged = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  for (const k of Object.keys(incoming)) {
    if (k === "hooks") continue;
    if (merged[k] === undefined) merged[k] = incoming[k];
  }
  merged.hooks = merged.hooks && typeof merged.hooks === "object" ? merged.hooks : {};
  const inHooks = incoming.hooks || {};
  for (const event of Object.keys(inHooks)) {
    const prior = Array.isArray(merged.hooks[event]) ? merged.hooks[event] : [];
    const kept = prior.filter((e) => !JSON.stringify(e).includes("spor-hook"));
    merged.hooks[event] = kept.concat(inHooks[event]);
  }
  return merged;
}

function targetPath(spec, scope) {
  return scope === "repo" ? path.join(repoRoot(), ...spec.repo) : path.join(homeDir(), ...spec.user);
}

function renderInstallExtra(extra) {
  if (extra.kind === "codex-agent") return renderCodexAgent(extra.src);
  throw new Error(`unknown install extra kind '${extra.kind}'`);
}

function installExtras(spec, scope, dryRun) {
  for (const extra of spec.extras || []) {
    const target = targetPath(extra, scope);
    const rendered = renderInstallExtra(extra);
    if (dryRun) {
      out(`would write ${target}:`);
      out(rendered.trimEnd());
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, rendered);
    out(`installed ${spec.label} extra → ${target}`);
  }
}

function hasCmd(cmd) {
  try {
    // Bounded: an unresponsive launcher (a hung shim, a broken wrapper script)
    // must not hang dispatch/install preflight forever — spawnSync's timeout
    // kills the child and sets .error, which the `!` below already treats as
    // "not available".
    return !spawnPortableSync(cmd, ["--version"], { stdio: "ignore", timeout: 5000 }).error;
  } catch {
    return false;
  }
}

function detectHosts() {
  const home = homeDir();
  const found = [];
  for (const h of Object.keys(HOST_PROBE)) {
    if (h === "claude") {
      if (hasCmd("claude") || fs.existsSync(path.join(home, ".claude"))) found.push(h);
      continue;
    }
    if (fs.existsSync(path.join(home, ...HOST_PROBE[h]))) found.push(h);
  }
  return found;
}

// Refresh Claude Code's loaded copy of the plugin to match the marketplace
// source (this checkout / the installed package): 'marketplace update' re-reads
// the source dir so a bumped package version is picked up, then 'plugin update'
// swaps the cached copy. Returns 0/1; prints a before→after line. The caller has
// already ensured the claude CLI exists and the marketplace is registered.
function refreshClaudePlugin(cmd, cliScope, before, cfg = null) {
  spawnPortableSync(cmd, ["plugin", "marketplace", "update", "spor"], { encoding: "utf8" });
  // Claude Code resolves an installed plugin by its name@marketplace id (the
  // install side uses 'spor@spor'); the bare 'spor' is unresolvable and fails
  // with "Plugin 'spor' not found" (issue-spor-upgrade-wrong-plugin-marketplace-id).
  const upd = spawnPortableSync(cmd, ["plugin", "update", "spor@spor", "--scope", cliScope], { stdio: "inherit" });
  if (upd.status !== 0) {
    err(`claude plugin update failed (exit ${upd.status == null ? "?" : upd.status})`);
    return 1;
  }
  const after = claudePluginInfo(cfg);
  const pkg = version();
  if (before && after && before.version !== after.version) {
    out(`spor plugin: ${before.version} → ${after.version} — restart your Claude Code session to load it.`);
  } else if (after && after.version === pkg) {
    out(`spor plugin already current (${after.version}).`);
  } else {
    out(`spor plugin refreshed (loaded ${after ? after.version : "?"}, package ${pkg}) — restart your session.`);
  }
  return 0;
}

// Claude Code: shell out to its plugin CLI (the stable contract; settings.json
// is CLI-owned). The marketplace IS this repo (.claude-plugin/marketplace.json,
// name "spor"), so 'marketplace add <ROOT>' then 'install spor@spor'. If the
// plugin is ALREADY installed, refresh it (marketplace+plugin update) instead of
// a no-op install, so re-running 'spor install claude' actually picks up a
// bumped package (issue-spor-upgrade-no-plugin-refresh).
function installClaude(scope, dryRun, cfg = null) {
  const cmd = claudeCmd(cfg);
  const cliScope = scope === "repo" ? "project" : "user";
  const addArgs = ["plugin", "marketplace", "add", ROOT];
  const instArgs = ["plugin", "install", "spor@spor", "--scope", cliScope];
  if (dryRun) {
    out(`would run: ${cmd} ${addArgs.join(" ")}`);
    out(`would run: ${cmd} ${instArgs.join(" ")}`);
    return 0;
  }
  if (cmd === "claude" && !hasCmd("claude")) {
    err("claude CLI not on PATH — install Claude Code, then re-run 'spor install claude'.");
    err(`meanwhile, load spor without a marketplace per session:  claude --plugin-dir ${ROOT}`);
    return 1;
  }
  const add = spawnPortableSync(cmd, addArgs, { encoding: "utf8" });
  if (add.status !== 0 && !/already|exists|known/i.test((add.stderr || "") + (add.stdout || ""))) {
    err(`claude plugin marketplace add failed: ${(add.stderr || add.stdout || "").trim() || "unknown error"}`);
    return 1;
  }
  const existing = claudePluginInfo(cfg);
  if (existing) return refreshClaudePlugin(cmd, cliScope, existing, cfg);
  const inst = spawnPortableSync(cmd, instArgs, { stdio: "inherit" });
  if (inst.status !== 0) {
    err(`claude plugin install failed (exit ${inst.status == null ? "?" : inst.status})`);
    return 1;
  }
  out(`installed spor@spor into Claude Code (scope: ${cliScope}) — no marketplace browsing needed.`);
  return 0;
}

// Codex CLI: install the repo as a Codex plugin via its marketplace commands,
// then keep the hook manifest + backfill custom agent installed. The plugin
// manifest intentionally does not carry hooks (Codex plugin validation rejects
// that field), so both halves matter.
function installCodex(scope, dryRun, cfg = null) {
  const cmd = codexCmd(cfg);
  // Use "." from ROOT instead of ROOT itself: Codex's source parser treats npm
  // scoped absolute paths containing /@scope/name as git owner/repo@ref-ish
  // input, which fails for local marketplaces (issue-spor-codex-install-npm-scope).
  const mpArgs = ["plugin", "marketplace", "add", "."];
  const pluginArgs = ["plugin", "add", "spor@spor"];
  if (dryRun) {
    out(`would run: (cd ${ROOT} && ${cmd} ${mpArgs.join(" ")})`);
    out(`would run: ${cmd} ${pluginArgs.join(" ")}`);
    return installHookHost(HOSTS.codex, scope, true);
  }
  if (cmd === "codex" && !hasCmd("codex")) {
    err("codex CLI not on PATH — install Codex, then re-run 'spor install codex'.");
    return 1;
  }
  const mp = spawnPortableSync(cmd, mpArgs, { encoding: "utf8", cwd: ROOT });
  if (mp.status !== 0 && !/already|exists|known/i.test((mp.stderr || "") + (mp.stdout || ""))) {
    err(`codex plugin marketplace add failed: ${(mp.stderr || mp.stdout || "").trim() || "unknown error"}`);
    return 1;
  }
  const plugin = spawnPortableSync(cmd, pluginArgs, { stdio: "inherit" });
  if (plugin.status !== 0) {
    err(`codex plugin add failed (exit ${plugin.status == null ? "?" : plugin.status})`);
    return 1;
  }
  out("installed spor@spor into Codex.");
  return installHookHost(HOSTS.codex, scope, false);
}

// JSON-hook hosts (codex/cursor/copilot/gemini): render + merge into the target.
// Reads the existing target strictly (readJsonStrict, defined below): a file
// that exists but isn't valid JSON aborts the install for this host instead of
// being silently clobbered by a permissive fallback — this is the file
// gemini's --mcp writer (writeMcpConfig) may ALSO target, so this strict read
// has to run before any write happens (issue-spor-gemini-config-clobbered-on-install).
function installHookHost(spec, scope, dryRun) {
  const target = targetPath(spec, scope);
  let existing;
  try {
    existing = readJsonStrict(target);
  } catch (e) {
    err(`spor install: ${e.message}`);
    return 1;
  }
  const merged = mergeHooks(existing, renderManifest(spec.src));
  if (dryRun) {
    out(`would write ${target}:`);
    out(JSON.stringify(merged, null, 2));
    installExtras(spec, scope, true);
    return 0;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(merged, null, 2) + "\n");
  out(`installed spor for ${spec.label} → ${target}  (scope: ${scope})`);
  installExtras(spec, scope, false);
  return 0;
}

// OpenCode has no command hooks — a JS plugin file is symlinked into place so it
// resolves the core via the link; copy is the Windows/EPERM fallback.
function installPluginHost(spec, scope, dryRun) {
  const src = path.join(ROOT, ...spec.src);
  const target = targetPath(spec, scope);
  if (dryRun) {
    out(`would link ${target} -> ${src}`);
    return 0;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.rmSync(target, { force: true });
  } catch {
    /* nothing there */
  }
  let how = "linked";
  try {
    fs.symlinkSync(src, target);
  } catch {
    const rendered = fs.readFileSync(src, "utf8").split("__SPOR_ROOT__").join(ROOT);
    fs.writeFileSync(target, rendered);
    how = "copied";
  }
  out(`installed spor for ${spec.label} → ${target}  (${how}, scope: ${scope})`);
  if (how === "copied") out(`  note: copied (no symlink here) — embedded SPOR_ROOT=${ROOT}.`);
  return 0;
}

// --- spor install --mcp: auto-write per-host MCP server config -------------
// (task-cc-spor-cli-install-mcp-automation) v1 only PRINTED the manual recipe
// each adapter README carries (see "MCP:" sections); --mcp is the opt-in
// automation of that recipe. Per-host shape varies enough that each gets its
// own renderer, but all share the same safety bar: read the existing file (if
// any), touch ONLY the spor entry, and write atomically (tmp + rename) so a
// write failure never leaves a half-written file. An existing file this can't
// safely read (bad JSON, unreadable) aborts loudly and changes nothing.
const MCP_HOSTS = {
  // Codex has no JSON mcpServers map — it's a TOML table under a DIFFERENT
  // file than the hooks manifest (~/.codex/config.toml, not hooks.json).
  codex: { kind: "toml", user: [".codex", "config.toml"], repo: [".codex", "config.toml"] },
  // Gemini's mcpServers entry lives in the SAME settings.json the hooks do —
  // installHookHost() has already written/merged it by the time this runs, so
  // this just adds one more top-level key to that same file.
  gemini: {
    kind: "json",
    user: [".gemini", "settings.json"],
    repo: [".gemini", "settings.json"],
    key: "mcpServers",
    entry: (url) => ({ httpUrl: url, headers: { Authorization: "Bearer $SPOR_TOKEN" } }),
  },
  opencode: {
    kind: "json",
    user: [".config", "opencode", "opencode.json"],
    repo: [".opencode", "opencode.json"],
    key: "mcp",
    entry: (url) => ({ type: "remote", url, headers: { Authorization: "Bearer {env:SPOR_TOKEN}" } }),
  },
  copilot: {
    kind: "json",
    user: [".copilot", "mcp-config.json"],
    repo: [".github", "mcp-config.json"],
    key: "mcpServers",
    entry: (url) => ({ type: "http", url, headers: { Authorization: "Bearer $SPOR_TOKEN" } }),
  },
};

// {} when the file is absent; throws a clear error when it exists but can't be
// read or isn't valid JSON — the caller aborts rather than clobbering it.
function readJsonStrict(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new Error(`can't read ${file}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} exists but isn't valid JSON — leaving it untouched`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} exists but isn't a JSON object — leaving it untouched`);
  }
  return parsed;
}

function writeMcpJson(spec, scope, dryRun, url) {
  const target = targetPath(spec, scope);
  let existing;
  try {
    existing = readJsonStrict(target);
  } catch (e) {
    err(`spor install --mcp: ${e.message}`);
    return 1;
  }
  const merged = { ...existing };
  const priorGroup = merged[spec.key];
  // An existing key of the WRONG shape (array, string, null) gets the same
  // treatment as unparseable top-level JSON: abort, don't discard it — the
  // contract is "touch ONLY the spor entry", never silently replace data.
  if (priorGroup !== undefined && (typeof priorGroup !== "object" || priorGroup === null || Array.isArray(priorGroup))) {
    err(`spor install --mcp: ${target} has a non-object '${spec.key}' — leaving it untouched`);
    return 1;
  }
  merged[spec.key] = priorGroup ? { ...priorGroup } : {};
  merged[spec.key].spor = spec.entry(url);
  const rendered = JSON.stringify(merged, null, 2) + "\n";
  if (dryRun) {
    out(`would write ${target}:`);
    out(rendered.trimEnd());
    return 0;
  }
  try {
    u.writeFileAtomic(target, rendered, { mkdir: true });
  } catch (e) {
    err(`spor install --mcp: could not write ${target}: ${e.message}`);
    return 1;
  }
  out(`wrote MCP config for spor → ${target}`);
  return 0;
}

function renderCodexMcpSection(url) {
  return `[mcp_servers.spor]\nurl = ${tomlString(url)}\nbearer_token_env_var = "SPOR_TOKEN"\n`;
}

// TOML has no zero-dep parser in this repo, so this doesn't parse the file —
// it locates our OWN `[mcp_servers.spor]` table by its header line and its
// own prior content (never hand-authored subtables), strips it, and appends a
// fresh copy. Everything else in the file survives untouched, which is also
// what makes a second run byte-identical.
function writeMcpToml(spec, scope, dryRun, url) {
  const target = targetPath(spec, scope);
  let existing = "";
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") {
      err(`spor install --mcp: can't read ${target}: ${e.message}`);
      return 1;
    }
  }
  const lines = existing.length ? existing.replace(/\r\n/g, "\n").split("\n") : [];
  const kept = [];
  let skip = false;
  for (const line of lines) {
    if (/^\[mcp_servers\.spor\]\s*$/.test(line.trim())) {
      skip = true;
      continue;
    }
    // A dotted subtable of our own section (e.g. a hand-added
    // `[mcp_servers.spor.env]`) must stay skipped along with its parent — only
    // a header that ISN'T `mcp_servers.spor` (itself or a subtable) ends the skip.
    if (skip && /^\[/.test(line.trim()) && !/^\[mcp_servers\.spor(\.|\])/.test(line.trim())) skip = false;
    if (!skip) kept.push(line);
  }
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  const prefix = kept.length ? kept.join("\n") + "\n\n" : "";
  const rendered = prefix + renderCodexMcpSection(url);
  if (dryRun) {
    out(`would write ${target}:`);
    out(rendered.trimEnd());
    return 0;
  }
  try {
    u.writeFileAtomic(target, rendered, { mkdir: true });
  } catch (e) {
    err(`spor install --mcp: could not write ${target}: ${e.message}`);
    return 1;
  }
  out(`wrote MCP config for spor → ${target}`);
  return 0;
}

function writeMcpConfig(host, scope, dryRun, url) {
  const spec = MCP_HOSTS[host];
  if (!spec) return 0;
  return spec.kind === "toml" ? writeMcpToml(spec, scope, dryRun, url) : writeMcpJson(spec, scope, dryRun, url);
}

async function cmdInstall(cfg, { values, positionals: pos }) {
  const dryRun = !!(values.print || values["dry-run"]);
  // Node prerequisite (issue-spor-onboarding-no-node-silent-fail-open). The
  // hooks fail open on a box with no/old Node (every one silently no-ops), so
  // make the requirement loud HERE, at wire-up time. A too-old interpreter is a
  // hard stop — installing the hooks on it just buys silent failure later.
  const nodeChk = nodeRuntimeCheck();
  if (!nodeChk.ok && !dryRun) {
    err(`prerequisite: ${nodeChk.line.replace(/^node:\s*/, "")}`);
    err(`  Spor's hooks fail open, so on this Node they install but every hook silently no-ops — upgrade Node first.`);
    return 1;
  }
  let scope = values.scope || "user";
  if (scope === "project") scope = "repo";
  if (scope !== "user" && scope !== "repo") {
    err(`invalid --scope '${scope}' — use 'user' or 'repo'`);
    return 1;
  }

  const bad = pos.find((a) => !HOSTS[a]);
  if (bad) {
    err(`unknown host '${bad}' — known: ${Object.keys(HOSTS).join(", ")}`);
    return 1;
  }
  let hosts = pos.slice();
  if (values.all) hosts = detectHosts();

  // writeAgentsBlock (the --mcp agents-md step below) resolves its server/graph
  // through scripts/engines/util.js's OWN active-config global, not this cfg
  // parameter directly — adopt cfg as that global now so it sees the full
  // cascade (repo .spor org/graph marker, user config.json, --org tenant),
  // not a raw-env fallback, even when --server/--token isn't passed THIS run.
  u.setConfig(cfg);

  // The "configure" half: persist server/token to user config when given.
  const server = values.server;
  const token = values.token;
  if ((server || token) && !dryRun) {
    try {
      const f = writeServerToken(cfg.userConfigHome(), server, token);
      out(`wrote ${[server && "server", token && "token"].filter(Boolean).join(" + ")} to ${f}`);
      // Reload so --mcp / the "next:" trailer below see the creds just
      // written, instead of the pre-write snapshot cfg was constructed from
      // (Config resolves its cascade once at load time, not per-get).
      const orgFlag = cfg.flagOrg();
      cfg = loadConfig({ cwd: process.cwd(), cli: orgFlag ? { org: orgFlag } : undefined });
      u.setConfig(cfg);
    } catch (e) {
      err(`could not write config: ${e.message}`);
    }
  }

  if (!hosts.length) {
    // Discovery mode — show what is installable; touch nothing.
    const found = detectHosts();
    out("Usage: spor install <host>... [--scope user|repo] [--all] [--print] [--mcp]");
    out(`Hosts: ${Object.keys(HOSTS).join(", ")}`);
    out(found.length ? `Detected here: ${found.join(", ")}  (try: spor install ${found.join(" ")})` : "No host config dirs detected yet.");
    out("Claude Code: 'spor install claude' wires the plugin via its CLI — no marketplace browsing.");
    // The plugin runs on Node; its hooks fail open when Node is absent/too old,
    // so state the requirement up front (issue-spor-onboarding-no-node-silent-fail-open).
    out(`Requires: Node ${nodeFloor() || 20}+ on PATH — currently ${nodeChk.line.replace(/^node:\s*/, "")}`);
    return 0;
  }

  // --mcp is opt-in auto-write of the per-host MCP server config (v1 only
  // printed the manual recipe — see MCP_HOSTS above). It needs a resolved
  // server to point the config at, so fail fast with a clear message rather
  // than writing a config that points nowhere. Prefer THIS invocation's own
  // --server (even under --print, where it's never persisted to disk) over
  // cfg's resolution, so `install <host> --mcp --server <url>` resolves in one
  // shot without depending on a config reload picking up what was just written.
  const wantMcp = !!values.mcp;
  const explicitServer = server ? server.replace(/\/+$/, "") : "";
  const resolvedServer = explicitServer || remote.base(cfg);
  const mcpUrl = wantMcp ? `${resolvedServer}/mcp` : "";
  if (wantMcp && !resolvedServer) {
    err("spor install --mcp needs a configured server — pass --server/--token (or run 'spor join <token>') first.");
    return 1;
  }

  let rc = 0;
  for (const host of hosts) {
    const spec = HOSTS[host];
    // Gemini's mcpServers entry lives in the SAME settings.json its hooks
    // manifest does (MCP_HOSTS.gemini.user/repo === HOSTS.gemini.user/repo).
    // installHookHost() now reads that target via readJsonStrict itself, so
    // a malformed existing settings.json aborts THERE, before writeMcpConfig()
    // ever runs — no separate pre-validation needed here
    // (issue-spor-gemini-config-clobbered-on-install).
    let r;
    if (spec.kind === "claude") r = installClaude(scope, dryRun, cfg);
    else if (spec.kind === "codex") r = installCodex(scope, dryRun, cfg);
    else if (spec.kind === "plugin") r = installPluginHost(spec, scope, dryRun);
    else r = installHookHost(spec, scope, dryRun);
    if (r !== 0) {
      rc = r;
      continue;
    }
    if (wantMcp && MCP_HOSTS[host]) {
      const mcpRc = writeMcpConfig(host, scope, dryRun, mcpUrl);
      if (mcpRc !== 0) rc = mcpRc;
    }
  }

  if (wantMcp && rc === 0) {
    if (dryRun) {
      out("would run: spor-hook agents-md (populates AGENTS.md)");
    } else {
      const { writeAgentsBlock } = require(path.join(ROOT, "scripts", "engines", "agents-md.js"));
      const { file, meta } = await writeAgentsBlock({ cwd: repoRoot(), briefing: true });
      out(`updated ${file} (${meta || "no briefing yet, MCP pointers only"})`);
    }
  }

  if (!dryRun && rc === 0 && hosts.some((h) => HOSTS[h].kind !== "claude")) {
    out("");
    out("next:");
    if (cfg.mode() === "remote") out(`  remote mode is configured (${remote.base(cfg)}).`);
    else out("  point at a graph:  spor join <token>   (hosted Spor; or 'spor join <url> <token>' / export SPOR_SERVER/SPOR_TOKEN)");
    // --mcp only automates the MCP-access half of this reminder (and only for
    // MCP_HOSTS hosts) — the distiller-backend pointer stays relevant either
    // way, and a host --mcp doesn't cover (e.g. cursor) still needs the README.
    out("  distiller backend (hosts without the claude CLI): see adapters/<host>/README.md");
    const mcpUncovered = hosts.some((h) => HOSTS[h].kind !== "claude" && !(wantMcp && MCP_HOSTS[h]));
    if (mcpUncovered) out("  on-demand MCP access: see adapters/<host>/README.md" + (wantMcp ? " (--mcp covers codex/gemini/opencode/copilot only)" : ""));
    out("  approve the hooks on first run if the host prompts.");
  }
  return rc;
}

// --- spor upgrade: refresh wired spor to the installed package version -------
// (issue-spor-upgrade-no-plugin-refresh) An npm bump updates the package on disk
// but NOT what an agent already loaded: Claude Code runs its OWN cached copy of
// the plugin, so it keeps running stale skills/hooks until 'plugin update' swaps
// the copy. Codex also caches an installed plugin copy, while its hooks still
// reference this checkout by absolute path. Re-running the idempotent install
// refreshes Codex's marketplace/plugin cache and rewrites the hook path. The
// other hook hosts reference the package by absolute path, so they only go stale
// if the checkout MOVED. This verb does both in one step and tells the user to
// restart the session.

// Refresh Claude Code's loaded plugin (marketplace add to register/repoint the
// source, then the shared marketplace+plugin update). Returns 0/1.
function upgradeClaude(scope, dryRun, cfg = null) {
  const cmd = claudeCmd(cfg);
  const cliScope = scope === "repo" ? "project" : "user";
  const mpAdd = ["plugin", "marketplace", "add", ROOT];
  const mpUpd = ["plugin", "marketplace", "update", "spor"];
  // Plugin id is name@marketplace ('spor@spor'); the bare name doesn't resolve
  // (issue-spor-upgrade-wrong-plugin-marketplace-id). Keep this dry-run preview
  // in sync with the real call in refreshClaudePlugin().
  const plUpd = ["plugin", "update", "spor@spor", "--scope", cliScope];
  if (dryRun) {
    out(`would run: ${cmd} ${mpAdd.join(" ")}`);
    out(`would run: ${cmd} ${mpUpd.join(" ")}`);
    out(`would run: ${cmd} ${plUpd.join(" ")}`);
    return 0;
  }
  if (cmd === "claude" && !hasCmd("claude")) {
    err("claude CLI not on PATH — install Claude Code, then re-run 'spor upgrade'.");
    return 1;
  }
  const before = claudePluginInfo(cfg);
  if (!before) {
    err("spor isn't installed in Claude Code yet — run 'spor install claude' first.");
    return 1;
  }
  // Re-register the marketplace source first, tolerating "already exists", so a
  // moved checkout repoints before the update re-reads it.
  const add = spawnPortableSync(cmd, mpAdd, { encoding: "utf8" });
  if (add.status !== 0 && !/already|exists|known/i.test((add.stderr || "") + (add.stdout || ""))) {
    err(`claude plugin marketplace add failed: ${(add.stderr || add.stdout || "").trim() || "unknown error"}`);
    return 1;
  }
  return refreshClaudePlugin(cmd, cliScope, before, cfg);
}

// Is spor actually wired into this host on this machine (vs the host merely being
// present)? claude: ask its plugin list; hook/plugin hosts: look for the spor
// marker in the target config. Picks which hosts 'spor upgrade' (no host) touches.
function hostHasSpor(host, scope, cfg = null) {
  if (host === "claude") return !!claudePluginInfo(cfg);
  const spec = HOSTS[host];
  if (!spec) return false;
  try {
    return /spor-hook|spor/.test(fs.readFileSync(targetPath(spec, scope), "utf8"));
  } catch {
    return false;
  }
}

async function cmdUpgrade(cfg, { values, positionals: pos }) {
  const dryRun = !!(values.print || values["dry-run"]);
  let scope = values.scope || "user";
  if (scope === "project") scope = "repo";
  if (scope !== "user" && scope !== "repo") {
    err(`invalid --scope '${scope}' — use 'user' or 'repo'`);
    return 1;
  }
  const bad = pos.find((a) => !HOSTS[a]);
  if (bad) {
    err(`unknown host '${bad}' — known: ${Object.keys(HOSTS).join(", ")}`);
    return 1;
  }
  // Explicit hosts win; otherwise refresh every detected host that has spor wired.
  let hosts = pos.slice();
  if (!hosts.length) hosts = detectHosts().filter((h) => hostHasSpor(h, scope, cfg));
  if (!hosts.length) {
    out("nothing to upgrade — spor isn't wired into any detected host. Run 'spor install <host>'.");
    return 0;
  }
  out(`package: @sporhq/spor ${version()} (this CLI)`);
  let rc = 0;
  for (const host of hosts) {
    let r;
    if (host === "claude") r = upgradeClaude(scope, dryRun, cfg);
    else if (host === "codex") r = installCodex(scope, dryRun, cfg);
    else {
      // Re-running install refreshes the absolute __SPOR_ROOT__ path (a no-op
      // when the path is unchanged; repairs a moved checkout when it is not).
      const spec = HOSTS[host];
      r = spec.kind === "plugin" ? installPluginHost(spec, scope, dryRun) : installHookHost(spec, scope, dryRun);
    }
    if (r !== 0) rc = r;
  }
  if (!dryRun) {
    // The committed AGENTS.md directive versions with the package — refresh
    // the current repo's managed block so wording changes actually ship
    // (task-spor-agents-md-capture-discipline-directive). No-op without one.
    await refreshAgentsBlockIfManaged();
    out("");
    out("Restart any running sessions so the refreshed hooks/plugin load.");
    // The refresh above closes the loaded-vs-installed gap; this closes the
    // installed-vs-published one — if npm has a newer release, the package on
    // disk itself is behind, so point the user at the npm bump (then re-upgrade).
    if (!values["no-net"]) {
      const latest = await npmLatest();
      const installed = version();
      if (latest && verCmp(installed, latest) < 0) {
        out("");
        out(`note: a newer @sporhq/spor is published — ${latest} (you have ${installed}).`);
        out(`  run: npm install -g @sporhq/spor@latest  &&  spor upgrade`);
      }
    }
  }
  return rc;
}

// --- spor dispatch: kick off a coding-agent run ---------------------------
// (task-spor-cli-dispatch-background-agents) Compile a briefing for a task and
// launch the harness in the correct repo — by default a SUPERVISED headless
// run (`claude -p --output-format stream-json` under the shared supervisor,
// dec-spor-claude-code-supervised-by-default; codex/opencode/copilot likewise);
// `--bg` / `dispatch.claudeLaunchMode` opts a Claude run into the native
// `claude --bg` agent instead. The "correct repo" comes
// from a per-machine slug->path map stored in the config cascade under
// `dispatch.repos` (read via cfg.get; written to $SPOR_HOME/config.json) — the
// shared graph is path-free by design (repo nodes carry slugs/fingerprints,
// never a local path; teammates clone to different paths), so the map MUST be
// local. It self-learns from session-start and from `--dir`/`spor repos`.

// Whether a node is CONFIRMED absent from the graph — as opposed to merely
// unreadable right now. resolveNode folds both into `null` (a 404, a 5xx, a
// transport error, an EACCES all read the same), which is fine for a caller
// that only wants to ACT on a node it can read, and wrong for one that wants
// to act on the node's ABSENCE: the checkProposals probe licenses a rollback
// of a completed item on "no landed fact", and a server blip must not be
// mistaken for that evidence (review F2). Only an explicit 404 (remote) or
// ENOENT (local) answers true; anything else is "unknown", and the caller
// treats unknown as not-absent.
async function nodeConfirmedAbsent(cfg, id) {
  if (cfg.mode() === "remote") {
    const r = await remote.get(cfg, `/v1/nodes/${encodeURIComponent(id)}`, { timeoutMs: 6000 });
    return !!(r && !r.ok && !r.transport && r.status === 404);
  }
  try {
    fs.statSync(path.join(cfg.nodesDir(), `${id}.md`));
    return false;
  } catch (e) {
    return !!(e && e.code === "ENOENT");
  }
}

// Resolve a node id to { id, raw, repo, title, summary, type, status, date } or
// null if it doesn't exist.
async function resolveNode(cfg, id) {
  let raw = "";
  // The server's get(node) hook attaches read-time enrichment as additive
  // top-level keys (API.md §3): `resolution` is the live inbound resolves/answers
  // edge (the resolver's id/summary/title), present only when the node is retired
  // by one. Keep it so the resolved-task guard can refuse without a second fetch.
  // `held` (schema-task.md get(), 2026.06.19.2) is the same hook's held-task churn
  // note — an open task with a recorded non-resolving outcome and no live blocker
  // — kept for the readiness guard's remote-mode warn (task-spor-dispatch-
  // readiness-guard): it's already computed server-side, so reusing it costs no
  // extra round trip. `inert` is the same additive-key contract for a future
  // server-computed queue-liveness-dead boolean (issue-spor-type-blind-terminal-
  // status-fallbacks) — a server that hasn't shipped it yet simply omits the
  // key, so this stays `null` (unknown, not "false") until dispatchResolutionReason
  // falls back to the offline check below.
  let resolution = null;
  let held = null;
  let inert = null;
  if (cfg.mode() === "remote") {
    const r = await remote.get(cfg, `/v1/nodes/${encodeURIComponent(id)}`, { timeoutMs: 6000 });
    if (!r.ok) return null;
    raw = (r.json && r.json.raw) || r.text || "";
    resolution = (r.json && r.json.resolution) || null;
    held = (r.json && r.json.held) || null;
    inert = (r.json && typeof r.json.inert === "boolean") ? r.json.inert : null;
  } else {
    try {
      raw = fs.readFileSync(path.join(cfg.nodesDir(), `${id}.md`), "utf8");
    } catch {
      return null;
    }
  }
  // Parse the frontmatter with the real parser (lib/kernel/graph.js) — a
  // single-line regex would truncate YAML folded multi-line values and,
  // unbounded by the closing `---`, could false-match a body line that
  // happens to start with "key: " (a real risk for summary/type/status/date,
  // all plausible words in body prose). parsed is {} on malformed/missing
  // frontmatter, so fields below fall back to "".
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  let parsed = {};
  try {
    parsed = graphLib.parseFrontmatter(raw, `${id}.md`);
  } catch {
    /* malformed frontmatter — fields below fall back to "" */
  }
  return {
    id,
    raw,
    repo: parsed.repo || parsed.project || null,
    title: parsed.title || "",
    summary: parsed.summary || "",
    type: parsed.type || "",
    status: parsed.status || "",
    date: parsed.date || "",
    resolution,
    held,
    inert,
  };
}

// Is this node ALREADY RESOLVED — so dispatching an agent at it would just redo
// finished work (issue-spor-dispatch-resolved-task-no-guard)? Two truths, matching
// the resolution kernel: a TERMINAL status (done/resolved/superseded/…) or a live
// inbound resolves/answers edge from an un-withdrawn resolver. Read off what
// resolveNode already fetched — remote mode gets the server's `resolution`
// enrichment plus the status line for free; local mode reads the status line and,
// only when it's non-terminal, loads the graph once to check for an inbound
// resolver. Returns a one-line reason when resolved, else null. Fail-open: any
// read error yields null (never block a dispatch on an unreadable graph).
//
// Type-aware in three tiers (issue-spor-type-blind-terminal-status-fallbacks):
// this function itself has no loaded graph, so it can't resolve a graph-
// resident schema override on its own — it prefers whatever already carries
// that context. 1) `node.inert` — a server-computed enrichment key on the
// GET /v1/nodes/{id} response (additive, API.md §3); trusted outright, BOTH
// values, when present (typeof boolean) since the server already evaluated
// the full type-aware partition, including graph-resident overrides, this
// function can't see — an explicit `false` must win over the offline check
// below exactly as much as a `true` short-circuits it, or the offline
// heuristic could silently overrule an authoritative server negative. 2)
// absent that (no server response in hand, or an older server that doesn't
// send the key yet) AND no local graph to consult (remote mode with a plain
// boolean-less response), the offline seed-registry check — still type-aware,
// just blind to graph-resident extensions. 3) in LOCAL mode this offline
// check must NOT short-circuit ahead of the real graph load below: the seed
// registry alone can't see a graph-resident schema override, so a status the
// seed pack calls terminal-by-default but a resident override has made live
// again would otherwise be wrongly reported as already-resolved before the
// authoritative graph check ever runs (a live node must not be skipped). The
// offline check is used in local mode only as the fail-open fallback when the
// graph itself is unreadable.
//
// CONTRACT — this function's polarity is "would dispatching this redo
// finished work", NOT "was this approved": its terminal-status branch treats
// EVERY retiring status (done/resolved/superseded/closed/abandoned/…) as
// already-resolved, on purpose — a dismissed or superseded node is exactly as
// unfinished-work-avoiding as a resolved one. That is the WRONG read for an
// approval gate, where a dismissal must not come back as an approval. Do not
// reuse this function (or its terminal-status/resolution logic) for an
// approval-polarity check — use gateApprovalState (below), which draws that
// distinction on purpose: a live resolving edge is approved, any other
// terminal status is rejected, anything else is pending.
function dispatchResolutionReason(cfg, node) {
  const status = (node.status || "").toLowerCase();
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  const fromEdge = (r) => `${r.edge || "resolves"} edge from ${r.by}${r.title ? ` — ${r.title}` : ""}`;
  if (node.inert === true) return `status: ${status}`;
  if (node.inert !== false && cfg.mode() === "remote") {
    if (graphLib.isTerminalStatusOffline(status, node.type || null)) return `status: ${status}`;
  }
  if (node.resolution && node.resolution.by) return fromEdge(node.resolution);
  if (cfg.mode() !== "remote") {
    try {
      const g = graphLib.loadGraph(cfg.nodesDir());
      // Re-check against the loaded graph's registry — strictly more
      // authoritative than the offline seed-only check, since it also sees a
      // graph-resident terminal-status extension or override
      // (issue-spor-coupling-resolution-terminal-status-divergence).
      if (isTerminalStatus(status, node.type || null, g)) return `status: ${status}`;
      const r = resolutionOf(g, node.id);
      if (r && r.by) return fromEdge(r);
    } catch {
      // Unreadable graph: fail open to the offline seed-registry check rather
      // than dropping the type-aware signal entirely — an unreadable graph
      // must never BLOCK a dispatch, but a genuinely finished node should
      // still be caught when we can't load the real registry to prove it.
      if (graphLib.isTerminalStatusOffline(status, node.type || null)) return `status: ${status}`;
    }
  }
  return null;
}

// Agent-readiness dispatch guard (task-spor-dispatch-readiness-guard, dec-spor-
// agent-readiness-derived-classification): classify what THIS dispatch is about
// to hand an agent, before launch. `requires: human` is the hard REFUSE case —
// the risk-class register's first consumer, work no agent can complete
// regardless of capability, mirroring the profile-satisfiability refusal (no
// --force bypass, the assignment stays intact). The broader `readiness: human`
// classification (assigned to a person, a held task, an open neighborhood
// question, or the item itself being a question/capture) WARNS loudly but does
// not block the dispatch.
//
// LOCAL mode loads the graph and runs the EXACT rankQueue derivation
// (lib/kernel/queue.js readinessOf) for this one node, front included — the
// same git-derived signal `spor next` uses. REMOTE mode has no client-side
// graph, so it approximates with a synthetic one-hop graph fed through the SAME
// deriveReadiness kernel function (so the reason wording matches the queue
// exactly): the requires:/readiness: stamps read straight off the node's own
// frontmatter (exact); an `assigned` edge's target type is inferred from the
// agent-id naming convention (isAgentId — the same discriminator
// resolveDispatchProfile already uses for this edge); `held` rides the server's
// already-shipped get() hook enrichment (schema-task.md, fetched by resolveNode
// — no extra round trip). Open questions in the 1-hop neighborhood are NOT
// checked remotely — a second fetch for a warn-only signal isn't worth paying
// (the get() hook has the identical gap: no front-floor twin either). Returns
// null on any read error or unknown node — fail-open, never blocks a dispatch
// on an unreadable graph.
function dispatchReadinessCheck(cfg, node) {
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  let parsed;
  try {
    parsed = graphLib.parseFrontmatter(node.raw, "node.md");
  } catch {
    return null;
  }
  if (cfg.mode() !== "remote") {
    try {
      const g = graphLib.loadGraph(cfg.nodesDir());
      if (!g.nodes[node.id]) return null;
      const queueLib = require(path.join(ROOT, "lib", "queue.js"));
      const days = cfg.getNum("queue.front.days", 7);
      const frontOn = cfg.getBool("queue.front.enabled", true);
      const front = frontOn ? queueLib.gitFront(path.dirname(g.nodesDir), path.basename(g.nodesDir), days) : null;
      return readinessOf(g, node.id, { front });
    } catch {
      return null; // fail-open — an unreadable graph never blocks a dispatch
    }
  }
  // Key by the node's OWN frontmatter id (deriveReadiness indexes graph.adj by
  // `node.id`, i.e. parsed.id here) rather than the requested id — they agree in
  // the overwhelming case, but keying consistently is what actually matters.
  const stubId = parsed.id || node.id;
  const stubNodes = { [stubId]: parsed };
  for (const e of parsed.edges ?? []) {
    if (e.type === "assigned" && !stubNodes[e.to]) {
      stubNodes[e.to] = { type: isAgentId(e.to) ? "agent" : "person" };
    }
  }
  const held = !!(node.held && Array.isArray(node.held.outcomes) && node.held.outcomes.length);
  return deriveReadiness({ nodes: stubNodes, adj: { [stubId]: [] } }, parsed, held, {}, true);
}

// Resolve the profile THIS dispatch would run UNDER and check whether this
// machine can satisfy it (dec-spor-machine-profile-satisfiability, FORK B).
// Precedence (cascade, explicit wins): --profile flag > the dispatched node's
// assigned->agent edge `profile:` attribute > that agent's default uses-profile.
// Returns null when NO profile resolves (no assignment, no profile nodes yet) —
// the common case, leaving dispatch byte-identical. Otherwise
// { id, source, found, profile, verdict }: an explicitly-named --profile that can't be
// loaded sets found:false (a hard error the caller reports); an INFERRED profile
// that can't be loaded returns null (fail-open — never block on a dangling edge).
async function resolveDispatchProfile(cfg, { profileFlag, nodeRaw, identityAgent }) {
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  const parse = (raw, f) => {
    try {
      return graphLib.parseFrontmatter(raw, f);
    } catch {
      return null;
    }
  };
  let id = profileFlag || null;
  let source = profileFlag ? "--profile" : null;
  const explicit = !!profileFlag;

  if (!id) {
    // The ASSIGNED agent comes from the dispatched node's `assigned -> agent`
    // edge — NOT from dispatch.agent (which only ATTRIBUTES the writes). When
    // several agents are assigned, prefer the edge to the dispatching identity.
    let assignedAgent = null;
    const n = nodeRaw ? parse(nodeRaw, "node.md") : null;
    if (n) {
      const assigned = (n.edges || []).filter(
        (e) => e && e.type === "assigned" && typeof e.to === "string" && isAgentId(e.to)
      );
      const edge = (identityAgent && assigned.find((e) => e.to === identityAgent)) || assigned[0] || null;
      if (edge) {
        assignedAgent = edge.to;
        // 1. the per-assignment profile override (the edge `profile:` attribute).
        if (edge.profile) {
          id = edge.profile;
          source = `assigned → ${edge.to}`;
        }
      }
    }
    // 2. else the assigned agent's DEFAULT profile (its uses-profile edge). Only
    // fetched when the node is genuinely assigned to an agent — never an
    // unconditional lookup on the common (unassigned / free-text) path.
    if (!id && assignedAgent) {
      const an = await resolveNode(cfg, assignedAgent);
      const a = an && an.raw ? parse(an.raw, "agent.md") : null;
      const up = a && (a.edges || []).find((e) => e && e.type === "uses-profile" && typeof e.to === "string");
      if (up) {
        id = up.to;
        source = `${assignedAgent} default`;
      }
    }
  }

  if (!id) return null;

  const pnode = await resolveNode(cfg, id);
  if (!pnode || !pnode.raw) return explicit ? { id, source, found: false, verdict: null } : null;
  const profile = parse(pnode.raw, "profile.md") || { id };
  // Re-probe THIS box before collapsing so the verdict reflects current reality —
  // crucially the deterministic reachable_mcp:[spor] seed
  // (task-spor-mcp-reachability-deterministic-seed): in remote mode the spor MCP
  // is reachable BY CONSTRUCTION in a dispatched session, so the probe seeds it
  // and an `mcp:[spor]` profile host-matches. Without this, a box whose .probed is
  // empty/stale (no prior session-start) would fail satisfies() for a profile it
  // can actually run, refusing or degrading the dispatch
  // (task-spor-dispatch-fresh-probe-before-satisfiability). Mirrors the
  // session-start auto-publish and the manual `spor capabilities publish`
  // (issue-spor-capabilities-publish-manual-no-spor-seed): probe with
  // sporReachable gated on remote mode, then merge the fresh probe over the
  // in-memory config. Best-effort — on failure fall back to the in-memory config.
  // Reached only AFTER a profile resolved (the early returns above), so a
  // profile-free dispatch stays byte-identical with no probe side effect.
  const rawCap = cfg.get("dispatch.capabilities", {}) || {};
  let probed = null;
  try {
    probed = u.probeCapabilities(cfg.userConfigHome(), { sporReachable: cfg.mode() === "remote", cfg });
  } catch {
    /* probe is best-effort; match against what the cascade already holds */
  }
  const machine = sat.effectiveCapabilities(probed ? { ...rawCap, probed } : rawCap);
  return { id, source, found: true, profile, verdict: sat.satisfies(machine, profile) };
}

// Compile a briefing: a node id -> its neighborhood; free text -> a digest.
// Mode-aware, reusing the primitives the /spor:brief skill drives. Default is
// the compact digest; `full` emits the whole neighborhood. "" = graph had
// nothing relevant (or the compile failed — fail-soft, dispatch still proceeds).
async function compileBriefing(cfg, { nodeId, query, full, project }) {
  if (cfg.mode() === "remote") {
    if (nodeId) {
      // Same raw-node + root-walk-neighborhood resolution as `spor brief <id>`,
      // so a dispatched agent's standing context matches an interactive brief
      // rather than the bare node (issue-spor-dispatch-briefing-omits-neighborhood).
      const b = await remoteNodeBriefing(cfg, { root: nodeId, project });
      return b.ok ? b.text : "";
    }
    const r = await remote.post(cfg, "/v1/digest", project ? { query, project } : { query });
    return r.ok && r.json && r.json.found !== false ? r.json.text || "" : "";
  }
  const args = nodeId ? ["--root", nodeId] : ["--query", query];
  if (!full) args.push("--digest");
  if (project) args.push("--project", project);
  args.push("--quiet"); // suppress the stderr stats / no-graph lines
  const r = spawnSync(process.execPath, [path.join(ROOT, "lib", "compile.js"), ...args], { encoding: "utf8" });
  return (r.stdout || "").trim();
}

// The dispatchable queue page for automatic selection: the ranked page for a
// project, minus every class an AGENT must never be picked for. Shared by
// `spor dispatch --from-queue` (which takes the top surviving item) and
// `spor work` (which walks the whole page filling its free slots), so the two
// can never drift on what is dispatchable — the loop adds no eligibility rule
// of its own beyond what it can see here (task-spor-work-loop). Mode-aware and
// fail-soft: [] on any error or empty queue.
// `eligible` is the caller's page-level filter (work-loop's pageEligible plus
// whatever the caller knows about its own slots: the readiness floor, the
// accept policy, the factory's repo scope, an item already in flight or
// cooling off here). When one is given and NOTHING on the page passes it, the
// page is REFETCHED wider — doubling to PAGE_LIMIT_CAP — until something does
// or the queue runs out. Without that, the policy filter runs after a
// fixed-size fetch, so a page filled by items this worker may not take
// (untriaged ones under the default `accept: ready`, a sibling repo's under a
// scoped factory) starves an eligible item ranked below it FOREVER: every poll
// refetches the same page. The queue has no offset, so widening is the whole
// re-page — at most three extra reads, and paid only by a pass that would
// otherwise have dispatched nothing at all. In local mode those reads share
// ONE graph load (the expensive half); remote mode pays a bounded GET each.
const PAGE_LIMIT_CAP = 200;
async function dispatchableQueuePage(cfg, slug, LIMIT = 25, { eligible = null, maxLimit = PAGE_LIMIT_CAP } = {}) {
  // Memo for THIS call only, so a widened local-mode read re-ranks the graph
  // it already loaded instead of re-reading every node file per step; the next
  // poll starts fresh and sees new nodes.
  const ctx = {};
  let limit = Math.max(1, LIMIT);
  let items;
  for (;;) {
    const raw = await fetchQueuePage(cfg, slug, limit, ctx);
    // A widened fetch that comes back EMPTY where a narrower one did not is a
    // blip (a server that went away mid-widening), not an emptier queue: keep
    // the page we already have, so this pass still records its skips.
    if (items && items.length && !raw.length) break;
    items = winnowQueuePage(raw);
    if (!eligible) break;
    if (items.some((it) => eligible(it))) break;
    // A short page is the whole queue: there is nothing deeper to widen into.
    if (raw.length < limit || limit >= maxLimit) break;
    limit = Math.min(limit * 2, maxLimit);
  }
  return items;
}

async function fetchQueuePage(cfg, slug, LIMIT, ctx = {}) {
  let items = [];
  // --from-queue dispatches an AGENT to do work, and questions are human
  // decisions — not agent-dispatchable (the standing model: agent-actionable
  // work is a task, not a question; dec-spor-questions-human-not-agent-dispatch).
  // Exclude them AT THE RANKER (the issue's preferred fix,
  // issue-spor-dispatch-from-queue-dispatches-questions): excludeTypes/
  // exclude_type is a hard scope filter applied BEFORE the limit, so the page is
  // a full LIMIT of actionable candidates rather than LIMIT-minus-questions —
  // the in-flight skip below then has the whole page to advance through (a page
  // crowded by top-ranked questions could otherwise starve it). Questions stay
  // queueable for the HUMAN queue (`spor next`). Sibling of
  // issue-spor-routed-questions-ignore-wake.
  if (cfg.mode() === "remote") {
    const base = `limit=${LIMIT}&exclude_type=question`;
    const q = slug ? `?project=${encodeURIComponent(slug)}&${base}` : `?${base}`;
    const r = await remote.get(cfg, `/v1/queue${q}`, { timeoutMs: 6000 });
    // Keep the ENVELOPE, not just `items`: a zero-match scope rides back as the
    // additive `project_warning` string (task-spor-remote-next-print-project-
    // warning), and discarding it here is what made a typo'd --project look
    // exactly like an empty queue to `spor work` / `dispatch --from-queue`.
    const warning = r.ok ? takeProjectWarning(r.json) : null;
    if (warning) warnQueueProjectOnce(slug, warning);
    items = r.ok && r.json ? r.json.items || [] : [];
  } else {
    try {
      const graphLib = require(path.join(ROOT, "lib", "graph.js"));
      if (!ctx.graph) ctx.graph = graphLib.loadGraph(cfg.nodesDir());
      const g = ctx.graph;
      // The local twin of the remote warning above (norm-spor-cli-mode-parity):
      // lib/queue.js prints this only from its CLI main, which rankQueue
      // bypasses, so say it here — same text, same once-per-token throttle.
      if (slug && !graphLib.projectKnown(g, slug)) {
        warnQueueProjectOnce(slug, `project '${slug}' matched no repo or grouping — queue is empty (try a repo slug, a repo-<slug> node id, or a grouping id)`);
      }
      const { rankQueue } = require(path.join(ROOT, "lib", "queue.js"));
      const opts = { limit: LIMIT, excludeTypes: ["question"] };
      const r = rankQueue(g, slug ? { project: slug, ...opts } : opts);
      items = r.items || [];
    } catch {
      items = [];
    }
  }
  return items;
}

// `spor work` re-reads the queue every poll (and widens it within a pass), so a
// scope warning is printed ONCE per token per process — the first read says it,
// where an operator watching the startup output sees it, and the loop's own
// scope-starvation notice carries it from there. Keyed by the token, so a
// worker whose scope changes mid-run (a later --project) still warns for the
// new one.
const warnedQueueProjects = new Set();
function warnQueueProjectOnce(slug, warning) {
  const key = String(slug || "");
  if (warnedQueueProjects.has(key)) return;
  warnedQueueProjects.add(key);
  err(warning);
}

// The hard exclusions applied to whatever the ranker returned — classes an
// AGENT must never be picked for, all of them defense-in-depth against a
// backend that ignores the scope filters above.
function winnowQueuePage(page) {
  let items = page || [];
  if (!items.length) return [];
  // Defense-in-depth: drop any question the ranker left in (an older server that
  // predates / ignores exclude_type), so a question is never dispatched even
  // against a stale backend. Primary exclusion is at the ranker above.
  items = items.filter((it) => it.type !== "question");
  if (!items.length) return [];
  // Defense-in-depth (dec-spor-queue-hide-blocked): a current ranker drops
  // blocked items from the page entirely, but a stale server may still return
  // them demoted (suggest:blocked / blocked_by set). --from-queue dispatches an
  // AGENT to do work, and a blocked item can't proceed until its unblocker
  // lands — never dispatch one, even against an old backend. Mirrors the
  // question defense above.
  items = items.filter((it) => it.suggest !== "blocked" && !(Array.isArray(it.blocked_by) && it.blocked_by.length));
  if (!items.length) return [];
  // Held-task hard skip (dec-spor-dispatch-from-queue-skip-held, the held-task
  // self-limit task-spor-queue-front-loop-self-limit-on-held-tasks): the ranker
  // damps a held task's front to 0 and flags it `suggest:triage` — an OPEN task
  // carrying a non-resolving outcome with no resolver and no live blocker, i.e.
  // held on an external gate with nothing to resolve. The damp sinks it below
  // actionable work but leaves it dispatchable, so a held task still top-ranked
  // by p1/blocking/heat could be auto-re-picked here — and --from-queue dispatches
  // an AGENT to DO work, while a held task awaits a TRIAGE decision (resolve / gate
  // with blocked-by / set wake / abandon), not re-work: dispatching it just writes
  // another non-resolving outcome and re-enters the churn the self-limit broke.
  // Skip it, mirroring the blocked filter above. Unlike blocked items it is NOT
  // hidden from `spor next` (the self-limit shows it, demoted, for human triage),
  // and an explicit `spor dispatch --node <id>` still sends it — only AUTOMATIC
  // selection skips it, so a held p1 stays deliberately dispatchable.
  items = items.filter((it) => it.suggest !== "triage");
  if (!items.length) return [];
  return items;
}

// The highest-ranked open queue item for --from-queue — the first that ISN'T
// already in flight on THIS machine. Fail-soft (null on any error/empty). This
// used to take limit=1 blindly, but the queue's lease filter is viewer-relative
// (lib/kernel/queue.js): a lease held by ANOTHER person is dropped, yet the
// dispatcher's OWN in-progress claim is kept and floated up by its `front`
// signal — so the top item was frequently the caller's own active work, which
// the same-machine guard then refused instead of advancing
// (task-spor-dispatch-from-queue-skip-in-flight). So pull a page and skip items
// with a background agent already running here — dispatchedAgents()/
// annotateInFlight, the same NO-LLM, fail-soft cross-reference the same-machine
// guard and `spor next --hide-dispatched` use — returning the first not-in-flight
// item. If EVERY candidate is in flight, fall back to the top one so the caller's
// guard reports it (rather than a misleading "queue empty"). A page (not just the
// top) is fetched in BOTH modes; with no agents in flight free[0] is still the
// top item, so the prior single-pick behavior is preserved.
async function topQueueItem(cfg, slug) {
  const items = await dispatchableQueuePage(cfg, slug);
  if (!items.length) return null;
  // Skip items already in flight on this machine; advance to the first free one.
  const { items: free, hidden } = annotateInFlight(items, dispatchedAgents(cfg), true);
  if (hidden && free.length) {
    err(`from-queue: skipped ${hidden} item(s) already in flight on this machine; picking ${free[0].id}`);
  }
  return free[0] || items[0] || null;
}

// Auto-claim a dispatched node so its lease is established at dispatch time
// (task-spor-dispatch-auto-claim), reusing the same claim/renew lease the
// post-tool heartbeat drives (dec-cc-task-claim-lease, task-cc-claim-nudge-hook).
// REMOTE-MODE ONLY: a claim is a server-held lease; local mode has no pool or
// contention (dec-cc-task-claim-lease "Local mode"), so the caller skips it and
// local dispatch stays byte-identical. PRE-LAUNCH the claim is PERSON-SCOPED
// (session omitted, dec-spor-dispatch-bg-session-late-bind): `claude --bg`
// IGNORES `--session-id` and self-allocates its real session, so the working
// session is NOT knowable up front — binding the lease to a forced uuid was a
// phantom (issue-spor-dispatch-bg-ignores-forced-session-id). Dispatch instead
// captures the real session post-launch and binds it via renewDispatch (and the
// bg agent's own post-tool heartbeat renews the same-session lease thereafter).
// A per-invocation `dispatch` nonce tags the claim so the server can distinguish
// a SECOND concurrent dispatch of the same node BY THE SAME PERSON from this
// person's own idempotent renew (inc-spor-dispatch-duplicate-task-2026-06-18):
// the lease holder is the person, so without the nonce a same-person re-claim
// just renews and a duplicate agent launches. With it, a live lease bearing a
// different nonce is 409 — closing the same-person/cross-machine duplicate the
// person-scoped lease and the same-machine guard miss.
//
// Returns {ok} on success/idempotent-renew, {conflict, message} when the node is
// already held (the concurrent-dispatch case this guards), or {error} for any
// other failure (fail-open: the caller warns and dispatches anyway).
async function claimDispatch(cfg, nodeId, session, dispatch) {
  const body = {};
  if (session) body.session = session;
  if (dispatch) body.dispatch = dispatch;
  const r = await remote.post(cfg, `/v1/nodes/${encodeURIComponent(nodeId)}/claim`, body, { timeoutMs: 6000 });
  if (r.ok) return { ok: true, lease: r.json && r.json.lease };
  // 409 = the node can't be claimed right now — a live lease held by ANOTHER
  // person, ANOTHER concurrent dispatch of ours (the dispatch-nonce conflict),
  // or occasionally a closed/terminal node. Either way don't launch a duplicate:
  // surface the server's message (it names holder + expiry for the lease case)
  // and let the caller abort.
  if (r.status === 409) {
    const e = (r.json && r.json.error) || {};
    return { ok: false, conflict: true, code: e.code || "conflict", message: e.message || "already claimed" };
  }
  // Anything else (transport down, 5xx, auth, a non-claimable node type) means
  // we couldn't establish the lease. Fail-open like the rest of the remote path
  // (dec-cc-fail-open-hooks / the fail-soft briefing compile): warn and dispatch
  // without a claim rather than blocking on an outage.
  const code = r.json && r.json.error && r.json.error.code;
  return { ok: false, error: r.transport ? r.error : `HTTP ${r.status}${code ? ` (${code})` : ""}` };
}

// Renew the dispatch lease, binding it to the REAL session captured post-launch
// (dec-spor-dispatch-bg-session-late-bind). The pre-launch claim was person-scoped;
// this binds the lease's session to the real `claude --bg` run so the lease and the
// rebound agent token agree from the start (instead of waiting for the agent's first
// heartbeat to self-heal it). Best-effort: a lapsed/stolen lease (409) or any other
// failure is swallowed — the bg agent's heartbeat still renews it. Returns {ok}.
async function renewDispatch(cfg, nodeId, session) {
  const r = await remote.post(cfg, `/v1/nodes/${encodeURIComponent(nodeId)}/renew`, { session }, { timeoutMs: 3000 });
  return { ok: !!r.ok };
}

// Late-bind the agent token's run session (dec-spor-dispatch-bg-session-late-bind).
// The token was minted session-DEFERRED before launch (the session wasn't knowable
// yet); this reports the REAL session captured from `claude agents --json`,
// authenticated by the AGENT TOKEN ITSELF (not the person token) so the server can
// set it on that token's record. Every subsequent write under the token then stamps
// the real session. Best-effort/fail-open: a server without the route (404), a
// conflict (409), or any transport error leaves the token session-null (writes carry
// no session — honest, never a phantom) rather than blocking dispatch. Returns
// {ok}|{absent}|{conflict}|{error}.
async function bindAgentSession(cfg, agentToken, session) {
  const r = await remote.post(cfg, `/v1/agents/session`, { session }, { timeoutMs: 3000, token: agentToken });
  if (r.ok) return { ok: true };
  if (r.status === 404) return { ok: false, absent: true };
  if (r.status === 409) return { ok: false, conflict: true };
  const code = r.json && r.json.error && r.json.error.code;
  return { ok: false, error: r.transport ? r.error : `HTTP ${r.status}${code ? ` (${code})` : ""}` };
}

// Resolve the directory to launch in. --dir wins; else a known slug is looked up
// in the map; else the cwd's durable repo root. { dir:null } means "slug unknown
// here". The cwd fallback uses dispatchRoot() (not repoRoot()) so a dispatch run
// from inside a linked worktree registers the main checkout, never the ephemeral
// worktree path (issue-spor-dispatch-worktree-dir-stamping).
function resolveDir(cfg, { dir, slug }) {
  if (dir) {
    const abs = path.resolve(dir);
    return { dir: abs, slug: slug || u.projectSlug(abs), source: "--dir" };
  }
  if (slug) {
    const p = (cfg.get("dispatch.repos", {}) || {})[slug];
    if (p) return { dir: p, slug, source: "config" };
    // Unmapped slug — but we may already be STANDING in that repo. If the cwd's
    // own inferred slug matches the target, resolve to the cwd's durable root
    // rather than erroring "run from inside that repo" at someone who already is
    // (issue-spor-dispatch-unmapped-slug-cwd-mismatch). The downstream real-run
    // self-register (registerRepo) then persists slug->dir so the next dispatch
    // from anywhere finds it. source "cwd-self" (not "cwd"): the slug DID match,
    // so this is a deliberate target hit, not the stampless-node silent fallback
    // the cwd-guard below refuses.
    if (slug === safeSlug()) return { dir: dispatchRoot(), slug, source: "cwd-self" };
    return { dir: null, slug, source: "unknown" };
  }
  return { dir: dispatchRoot(), slug: safeSlug(), source: "cwd" };
}

// Does the checkout at `dir` legitimately host `slug` — as its own root identity,
// OR via a monorepo subtree `.spor` marker below it? The corrupt-mapping guard
// uses this to tell a genuine cross-repo mismatch (spor-server -> the client repo,
// which hosts NO marker for spor-server) from a LEGITIMATE subtree mapping that
// session-start itself writes (my-api -> the shared root, where services/api/.spor
// pins `repo: my-api`, so projectSlug(root) != my-api yet the mapping is correct;
// issue-cc-project-identity-monorepo-worktree). Only called on the cold mismatch
// path (projectSlug(dir) already != slug), so the bounded subtree scan never runs
// on a correct dispatch. Depth-bounded and skips heavy/irrelevant dirs so it stays
// cheap even on a large tree.
function dirHostsSlug(dir, slug) {
  if (u.projectSlug(dir) === slug) return true; // root identity
  const SKIP = new Set([".git", "node_modules", ".claude", "dist", "build", "coverage", ".next", "vendor", "target"]);
  const MAX_DEPTH = 3; // services/<area>/.spor is depth 2; a little headroom
  const stack = [[dir, 0]];
  while (stack.length) {
    const [d, depth] = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      // A flat `.spor` marker pins this subtree's slug — projectSlug walks up to it.
      if (e.isFile() && e.name === ".spor" && u.projectSlug(d) === slug) return true;
    }
    if (depth < MAX_DEPTH) {
      for (const e of ents) {
        if (e.isDirectory() && !SKIP.has(e.name)) stack.push([path.join(d, e.name), depth + 1]);
      }
    }
  }
  return false;
}

// Quote an argv element for the --print display only (never used to spawn).
function shellQuote(s) {
  return /[^\w./:-]/.test(s) ? `'${String(s).replace(/'/g, "'\\''")}'` : s;
}

// --- Dispatch worktree isolation -----------------------------------------
// Run each dispatched agent in its OWN git worktree off the target repo so
// concurrent dispatches never race the shared working tree/index — the
// stale-working-tree / shared-checkout-CAS class (issue-spor-live-server-stale-
// working-tree). Opt-in per repo (dispatch.worktree); dispatch OWNS the
// lifecycle (create + setup hook + launch cwd) rather than `claude --bg`'s own
// --worktree, because that is a bare `git worktree add` we can't prep before the
// agent starts AND the launcher env never reaches the bg agent (it self-allocates
// a spare worker). So the per-repo setup hook is the only place spor-server-class
// deps (a node_modules symlink, $SPOR_LIB via the worktree's own
// .claude/settings.local.json `env`) can be staged. The generic client knows
// nothing of those — it just runs the configured hook.

// A node id is already a clean branch/dir token; a free-text dispatch name may
// carry spaces/punctuation that `git worktree add -b` rejects — sanitize to the
// git-ref-safe subset the worktree dir and its branch both use.
function worktreeName(name) {
  return (
    String(name || "")
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 80) || "dispatch"
  );
}

// Where a dispatched worktree lives — mirrors the .claude/worktrees/<name>
// convention `claude --worktree` itself uses. Pure (no side effect) so the
// --print preview and the real run agree on the path.
function dispatchWorktreeDir(repoDir, name) {
  return path.join(repoDir, ".claude", "worktrees", worktreeName(name));
}

// Create (or reuse) the dispatch worktree and run the optional setup hook.
// Branches off LOCAL HEAD, never origin (local main is routinely ahead of
// origin/main — worktree-base-ref-stale-origin). The setup hook runs with
// cwd=worktree and the dispatch context in the env; `shell: true` lets the
// config value be a script path OR an inline command. Returns { dir, branch,
// reused, setupRan } on success; { error } if the worktree couldn't be made; or
// { setupError, created, ... } the caller turns into an abort.
function createDispatchWorktree(repoDir, name, { slug, nodeId } = {}) {
  const branch = worktreeName(name);
  const dir = dispatchWorktreeDir(repoDir, name);
  let reused = false;
  if (fs.existsSync(dir)) {
    reused = true; // a prior dispatch (or --force re-run) left it — reuse in place
  } else {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // Attach to an existing branch of this name if one survives a removed
    // worktree; otherwise cut a fresh branch off HEAD.
    const branchExists =
      git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
    const addArgs = branchExists
      ? ["worktree", "add", dir, branch]
      : ["worktree", "add", "-b", branch, dir, "HEAD"];
    const r = git(repoDir, addArgs);
    if (r.status !== 0) {
      return { error: (r.stderr || r.stdout || "git worktree add failed").trim() };
    }
  }
  // Resolve dispatch.worktreeSetup from the WORKTREE'S OWN checkout, never the
  // main checkout's live .spor.json (issue-spor-dispatch-worktree-config-live-
  // file-race). `git worktree add ... HEAD` above cuts `dir` from HEAD, but the
  // main checkout's working tree/index routinely lags HEAD (a stale index is
  // the normal post-merge state after a CAS `update-ref`, per
  // dec-spor-docs-worktree-setup-hook-dirty-checkout-race) — reading the
  // config from `repoDir` at this point can silently miss a just-merged
  // worktreeSetup with no error. `dir` always reflects the exact commit the
  // worktree was cut from (or, on reuse, whatever commit it already has
  // checked out — still more accurate than the main checkout's live state),
  // and a relative worktreeSetup path resolves against `dir` too, so the
  // script itself comes from the same checkout, not a possibly-stale sibling
  // in the main tree.
  //
  // `boundary: dir` is what makes that hold for the STANDING cascade too. A
  // dispatch worktree nests at `<repoDir>/.claude/worktrees/<name>`, so
  // loadConfig's ordinary repo-file ancestor walk would climb straight back
  // into `repoDir` and read the main checkout's live, possibly uncommitted
  // `.spor.json` — reintroducing the very race by the back door. The boundary
  // fences every repo-file marker walk at the worktree root (see
  // lib/config.js markerSearchDirs). Only the REPO-FILE layers are fenced:
  // env, the user `$SPOR_HOME/config.json`, and the global config still apply,
  // so a machine-local `dispatch.worktreeSetup` keeps working — that one isn't
  // the main checkout's file. targetRepoDispatchCfg reads exactly
  // `<dir>/.spor.json` with no walk at all, so it needs no fence.
  const hook = runWorktreeSetupHook(dir, { repoDir, slug, nodeId, stdio: "inherit", role: "dispatch" });
  if (hook.error) return { dir, branch, reused, created: !reused, setupError: hook.error };
  return { dir, branch, reused, setupRan: hook.ran };
}

// Run the repo's `dispatch.worktreeSetup` hook in a freshly-cut worktree —
// shared by the dispatch worktree above and by the gate pipeline's throwaway
// trees (a command gate's tree, the integration stage's candidate tree; see
// makeGateDeps/makeIntegrationDeps). A bare `git worktree add` lacks whatever
// the repo's suite needs that is not in git — a node_modules symlink, a pinned
// sibling-checkout path — and the hook is the ONE place a repo declares how to
// stage that. Running it only for the implementer's worktree and not for the
// tree the suite is judged in makes a factory whose repo needs the hook fail
// its own acceptance gate on a missing dependency, every time, on a tree the
// implementer never touched.
//
// Resolved from the WORKTREE's own checkout, never the main checkout's live
// .spor.json (issue-spor-dispatch-worktree-config-live-file-race), with the
// standing cascade fenced at the worktree root — see the comment that used to
// sit inline in createDispatchWorktree, now the shape below. Returns
// {ran: false} when no hook is declared, {ran: true} when it ran clean, and
// {error} — a message, not a throw — when it failed.
function runWorktreeSetupHook(dir, { repoDir, slug = null, nodeId = null, stdio = "inherit", role = "dispatch" } = {}) {
  return runWorktreeHook("setup", dir, { repoDir, slug, nodeId, stdio, role });
}

// The teardown twin (task-spor-worktree-hook-role-and-teardown): the repo's
// `dispatch.worktreeTeardown`, run before a tree is removed — the implementer
// worktree after a landing, a command gate's tree, the integration candidate
// — with the same env the setup hook got, so whatever setup started for that
// tree (a database stack on a per-tree port, a dev server) can be stopped.
// `SPOR_TREE_ROLE` (dispatch | gate | integration) tells both hooks which
// tree they are staging, so a hook can start a service only for the trees
// whose suite needs it.
function runWorktreeTeardownHook(dir, { repoDir, slug = null, nodeId = null, stdio = "pipe", role = "dispatch" } = {}) {
  return runWorktreeHook("teardown", dir, { repoDir, slug, nodeId, stdio, role });
}

function runWorktreeHook(which, dir, { repoDir, slug = null, nodeId = null, stdio = "inherit", role = "dispatch" } = {}) {
  // `boundary: dir` is what keeps the STANDING cascade honest too: a dispatch
  // worktree nests at `<repoDir>/.claude/worktrees/<name>`, so loadConfig's
  // ordinary repo-file ancestor walk would climb straight back into `repoDir`
  // and read the main checkout's live, possibly uncommitted `.spor.json`. The
  // boundary fences every repo-file marker walk at the worktree root; env, the
  // user `$SPOR_HOME/config.json` and the global config still apply, so a
  // machine-local `dispatch.worktreeSetup` keeps working.
  const cfg = targetRepoDispatchCfg(dir);
  const standingCfg = loadConfig({ cwd: dir, env: process.env, boundary: dir });
  const key = which === "teardown" ? "worktreeTeardown" : "worktreeSetup";
  const setup = cfg[key] != null ? cfg[key] : standingCfg.get(`dispatch.${key}`, null);
  if (!setup) return { ran: false };
  const sr = spawnSync(setup, [], {
    cwd: dir,
    stdio,
    shell: true,
    // Scrubbed of the git location vars (u.gitEnv): the hook stages the fresh
    // worktree, so its git must follow cwd rather than an ambient GIT_DIR
    // inherited from whatever launched dispatch
    // (issue-spor-dispatch-worktree-wrong-repo-location).
    env: {
      ...u.gitEnv(),
      SPOR_WORKTREE: dir,
      SPOR_MAIN_CHECKOUT: repoDir,
      SPOR_DISPATCH_SLUG: slug || "",
      SPOR_DISPATCH_NODE: nodeId || "",
      SPOR_TREE_ROLE: role || "dispatch",
    },
  });
  if (sr.error) return { ran: true, error: sr.error.message };
  if (sr.status !== 0) {
    const tail = stdio === "pipe" ? String(sr.stderr || sr.stdout || "").trim().split("\n").filter(Boolean).pop() : "";
    return { ran: true, error: `${which} hook exited ${sr.status}${tail ? `: ${tail}` : ""}` };
  }
  return { ran: true };
}

// The durable MAIN checkout a worktree (or a plain checkout) belongs to —
// `dirname(--git-common-dir)`, the same resolution removeDispatchWorktree and
// the hooks' inferenceRoot use. Null when `dir` is not a git checkout at all.
function mainCheckoutOf(dir) {
  const common = (git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout || "").trim();
  return common ? path.dirname(common) : null;
}

// The `env` block a worktree's own `.claude/settings.local.json` declares — the
// channel the spor-server setup hook uses to pin `$SPOR_LIB` for the agent
// that will run there (a launcher's env never reaches a `claude --bg` agent,
// so the hook writes it where the harness reads it). A gate's suite runs in
// such a tree under THIS process, not under a harness, so the same block is
// folded into the suite's env here — otherwise the hook's pin reaches the
// implementer and not the judge. Fail-soft: no file, or an unreadable one, is
// simply no extra env.
// Stage one of the gate pipeline's THROWAWAY trees (a command gate's tree, the
// integration candidate) with the repo's worktree-setup hook. `top` is the
// checkout the tree was cut from (the implementer's worktree, typically), from
// which the durable main checkout — what the hook receives as
// SPOR_MAIN_CHECKOUT, and where a node_modules symlink should point — is
// derived. Shape matches the gate deps' own {ok, reason} contract: a hook that
// fails refuses the tree, it never runs the suite on a half-staged one.
function stageThrowawayTree(dir, top, { slug = null, nodeId = null, what = "gate", role = "gate" } = {}) {
  const repoDir = mainCheckoutOf(top) || top;
  const hook = runWorktreeSetupHook(dir, { repoDir, slug, nodeId, stdio: "pipe", role });
  if (hook.error) return { ok: false, reason: `the repo's dispatch.worktreeSetup hook failed staging the ${what} tree: ${hook.error}` };
  return { ok: true, ran: !!hook.ran };
}

// The teardown for a throwaway tree — best-effort by contract (the tree is
// going either way), so a failing hook is a warning, never a refusal.
function teardownThrowawayTree(dir, top, { slug = null, nodeId = null, role = "gate", warn = () => {} } = {}) {
  const repoDir = mainCheckoutOf(top) || top;
  const hook = runWorktreeTeardownHook(dir, { repoDir, slug, nodeId, stdio: "pipe", role });
  if (hook.error) warn(`work: the repo's dispatch.worktreeTeardown hook failed on the ${role} tree ${dir}: ${hook.error}`);
  return hook;
}

function worktreeDeclaredEnv(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.local.json"), "utf8"));
    const env = parsed && parsed.env;
    if (!env || typeof env !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

// Best-effort teardown of a worktree WE just created (setup-hook failure path):
// never strand a half-prepped worktree + branch. A reused worktree is left
// untouched (it predates this dispatch) — the call site checks wt.created
// before ever calling this.
//
// Defense in depth against the issue-spor-orchestrator-cleanup-worktree-leak
// class of bug (a cleanup routine hard-resetting a DIFFERENT active worktree):
// this is a destructive removal, so before touching anything it refuses
// unless (a) `dir` is genuinely a worktree of `repoDir` (its --git-common-dir
// resolves back to repoDir, the same test inferenceRoot() uses) and (b) it has
// no uncommitted changes. The one call site today always passes the exact
// {dir, branch} it just created, so neither check should ever fire in
// practice — but a future caller mistake, or an external process pointed at
// the wrong path, must be refused rather than silently forced. Returns
// { removed: true } or { removed: false, reason }.
function removeDispatchWorktree(repoDir, dir, branch) {
  const common = (git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout || "").trim();
  const mainCheckout = common ? path.dirname(common) : "";
  // Compared CANONICALIZED (u.canonPath): git answers in the long, resolved
  // form, while `repoDir` is whatever the caller spelled — an 8.3 short name
  // on Windows (os.tmpdir() is `…\RUNNER~1\…` on the CI runner), a
  // /var -> /private/var symlink on macOS — and a spelling mismatch here read
  // as "not a worktree of repoDir", stranding the half-prepped worktree the
  // guard exists to clean up (inc-spor-windows-ci-main-failing).
  if (!mainCheckout || u.canonPath(mainCheckout) !== u.canonPath(repoDir)) {
    return { removed: false, reason: `${dir} is not a worktree of ${repoDir} — refusing to remove` };
  }
  const status = git(dir, ["status", "--porcelain"]);
  if (status.status !== 0 || (status.stdout || "").trim()) {
    return { removed: false, reason: `${dir} has uncommitted changes — refusing to remove` };
  }
  // The branch IS the node id for a node dispatch (worktreeName), which is
  // what the hook's SPOR_DISPATCH_NODE carried on the way in.
  runWorktreeTeardownHook(dir, { repoDir, nodeId: branch || null, stdio: "pipe", role: "dispatch" });
  git(repoDir, ["worktree", "remove", "--force", dir]);
  if (branch) git(repoDir, ["branch", "-D", branch]);
  return { removed: true };
}

// Read the TARGET repo's committable .spor.json for its own dispatch.worktree[
// /Setup]. The standing cfg cascade is anchored at the DISPATCHER's cwd (lib/
// config.js layer 3 walks up from cwd), not res.dir — so without this a
// cross-repo --slug/--dir dispatch wouldn't honor the target repo's declared
// preference. A relative setup path resolves against the repo dir, so a
// committable marker stays machine-portable (no absolute paths in a shared file).
// Fail-open: a missing/malformed marker yields {} (no override).
function targetRepoDispatchCfg(dir) {
  let d;
  try {
    d = (JSON.parse(fs.readFileSync(path.join(dir, ".spor.json"), "utf8")) || {}).dispatch;
  } catch {
    return {};
  }
  if (!d || typeof d !== "object") return {};
  const out = {};
  if (typeof d.worktree === "boolean") out.worktree = d.worktree;
  if (typeof d.worktreeSetup === "string" && d.worktreeSetup) {
    out.worktreeSetup = path.isAbsolute(d.worktreeSetup) ? d.worktreeSetup : path.join(dir, d.worktreeSetup);
  }
  if (typeof d.worktreeTeardown === "string" && d.worktreeTeardown) {
    out.worktreeTeardown = path.isAbsolute(d.worktreeTeardown) ? d.worktreeTeardown : path.join(dir, d.worktreeTeardown);
  }
  return out;
}

// Render a Handlebars-style {{placeholder}} prompt template against a vars map
// (task-spor-dispatch-user-prompt-templates). Keys match case-insensitively and
// tolerate inner whitespace ({{ brief }} == {{brief}}); a known key substitutes,
// an unknown one substitutes to "" and is collected so the caller can warn. This
// is the same {{VAR}} convention the externalized server prompts use
// (dec-prompts-externalized-templates) — kept to a zero-dep single pass rather
// than pulling in Handlebars. The pass is single-shot via a replace callback, so
// a substituted value that itself contains {{...}} is never re-scanned.
function renderTemplate(tpl, vars) {
  const unknown = [];
  const text = String(tpl).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key) => {
    const k = key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(vars, k)) return vars[k];
    unknown.push(key);
    return "";
  });
  return { text, unknown };
}

// Re-enable Spor for a repo by merging { enabled: true } into its committable
// .spor.json (and clearing a `mode: off`, which also disables). Used by the
// --backfill onboarding to repair a repo a prior `spor disable` turned off.
function enableRepoAt(dir) {
  const file = path.join(dir, ".spor.json");
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    /* absent or malformed — start fresh */
  }
  data.enabled = true;
  if (data.mode === "off") delete data.mode;
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  } catch {
    /* non-fatal */
  }
}

// `spor dispatch --backfill` is the unattended onboarding primitive behind the
// /spor:onboard skill (task-spor-cli-dispatch-background-agents): set the repo
// up before launching its backfill agent. Idempotent; prints what it did. The
// dir-registration happens in cmdDispatch (it applies to every dispatch), this
// adds the init + enable steps.
function onboardRepo(cfg, dir) {
  // Init the local graph home — but only in local mode; remote mode keeps the
  // graph on the server, so there is nothing to create locally.
  if (cfg.mode() !== "remote") {
    const r = ensureGraphHome(cfg);
    out(r.created ? `initialized graph home at ${r.home}` : `graph home ready: ${r.home}`);
  }
  // Re-enable the repo if a prior `spor disable` turned it off, so onboarding a
  // disabled repo actually works instead of silently launching into a no-op.
  if (!cfg.enabled()) {
    enableRepoAt(dir);
    out(`re-enabled Spor for ${dir}`);
  }
}

// --- dispatch agent identity (dec-spor-session-identity-active-record) -----
// A dispatched session runs AS this machine's agent, carried on a per-session
// agent-scoped MCP token (env does NOT propagate through `claude --bg`, so
// identity rides the token in --mcp-config, never env). These helpers report
// what they found or minted; the CALLER (cmdDispatch) decides what to do with
// a miss — per dec-spor-worker-strictness-split-interactive-lenient that is a
// HARD FAIL by default (no agent configured, or minting failed), never a
// silent degrade to person-scoped attribution, unless the caller opted into
// --allow-person-token / dispatch.allowPersonToken.

// This machine's agent node id, or null. A per-machine config key the shared
// graph can't hold (like dispatch.repos) — SPOR_DISPATCH_AGENT / .spor.json
// {"dispatch":{"agent":"agent-x"}} / user config. null => no agent identity to
// dispatch under (the caller decides whether that's a hard-fail or, with
// --allow-person-token, a graceful person-attributed dispatch as before).
function dispatchAgentId(cfg) {
  return cfg.get("dispatch.agent", null) || null;
}

// Mint a per-session agent-scoped token (dec-spor-session-identity-active-record):
// carries the agent (spiffe sub), the person (RFC 8693 act.sub), and the session
// id; audience-restricted, short TTL — the server is the CA. SELF-SERVE and
// OWNERSHIP-gated, NOT admin-gated: POST /v1/agents/{id}/token authenticated with
// the dispatcher's normal person token (SPOR_TOKEN); the server checks the caller
// OWNS agent {id} (the owned-by edge) — so a normal teammate can mint a token for
// their own machine's agent without being an admin. REMOTE only. The token is
// minted session-DEFERRED (session omitted) when the real session isn't yet known
// — the standing case, since `claude --bg` allocates it only at launch
// (dec-spor-dispatch-bg-session-late-bind); dispatch binds the real session
// afterward via bindAgentSession. The `session` param is kept for a caller that
// genuinely knows it up front (none today — dispatch always defers). Returns
// { ok, token } on success, { absent:true } when the mint surface isn't deployed
// yet (404), or { error } on any other failure incl. 403/owner-mismatch — both
// misses are reported to the caller, which hard-fails by default
// (--allow-person-token opts back into the old fail-soft, warn-and-proceed).
async function mintAgentToken(cfg, { agent, session }) {
  const r = await remote.post(cfg, `/v1/agents/${encodeURIComponent(agent)}/token`, session ? { session } : {}, { timeoutMs: 6000 });
  if (r.transport) return { error: r.error };
  // 404 = no route (surface not deployed) => absent, dispatch falls back cleanly.
  if (r.status === 404) return { absent: true };
  if (!r.ok) return { error: `HTTP ${r.status}${r.json && r.json.error && r.json.error.code ? ` (${r.json.error.code})` : ""}` };
  const token = r.json && (r.json.token || r.json.access_token);
  if (!token) return { absent: true };
  return { ok: true, token };
}

// Write the 0600 --mcp-config JSON that gives the bg agent ONLY its own
// agent-scoped Spor MCP (account connector excluded by --strict-mcp-config,
// verified #1). Machine-local, gitignored-adjacent path under the user config
// home's outbox; per-dispatch filename (`key`, a fresh uuid) so concurrent
// dispatches don't collide — the session id is no longer known at this point
// (deferred until post-launch, dec-spor-dispatch-bg-session-late-bind). Returns
// the file path. The bg agent reads it on startup AFTER this process exits (claude
// --bg detaches), so we cannot delete it eagerly — cleanup is a best-effort sweep
// of stale files here, plus the documented short-TTL token inside it.
function writeDispatchMcpConfig(cfg, { token, key }) {
  const dir = path.join(cfg.userConfigHome(), "outbox", "dispatch");
  fs.mkdirSync(dir, { recursive: true });
  sweepStaleMcpConfigs(dir);
  const file = path.join(dir, `mcp-${key}.json`);
  const conf = {
    mcpServers: {
      spor: {
        type: "http",
        url: `${remote.base(cfg)}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
  // 0600: the file holds a live bearer token. Create with O_EXCL (wx) so a
  // pre-placed file or symlink at this path is REFUSED rather than written
  // through, and the file is 0600 from creation (no widen-then-narrow window).
  // The uuid filename makes a real collision a non-issue; a stale leftover was
  // swept above.
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(conf, null, 2) + "\n");
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

// Best-effort cleanup: remove dispatch mcp-config files older than a day. The
// tokens inside are short-TTL, but the files linger because claude --bg reads
// them after we exit; sweep on the next dispatch so they don't accumulate.
function sweepStaleMcpConfigs(dir) {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(dir)) {
      if (!/^mcp-.*\.json$/.test(f)) continue;
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {
        /* racing another dispatch — ignore */
      }
    }
  } catch {
    /* dir vanished or unreadable — nothing to sweep */
  }
}

const DISPATCH_RUNNER = path.join(ROOT, "lib", "shell", "agent-dispatch-runner.js");

// Test seam: SPOR_DISPATCH_RUNNER_CMD substitutes the whole supervisor
// process (normally `node agent-dispatch-runner.js <job>`) with an arbitrary
// spawnable command that receives the job file path as its only argument —
// the runner-process analogue of the harness-level SPOR_CODEX_CMD/
// SPOR_CLAUDE_CMD seams. Lets a test pin a supervisor that crashes on
// startup, exercising launchSupervisedHarness's supervisor-exited-early
// branch deterministically instead of relying on a real startup crash/OOM to
// happen to occur (task-spor-dispatch-supervisor-test-seam). Unset (the
// default) reproduces the exact prior invocation. A `.js` override runs under
// THIS node, like the real runner: the supervisor is spawned with no shell
// (its handshake rides an extra stdio pipe a cmd.exe hop would not inherit),
// and Node refuses a bare `.cmd`/`.bat` spawn on Windows (EINVAL,
// CVE-2024-27980), so a script is the one override shape that launches the
// same way on every platform.
function dispatchRunnerCommand(env = process.env) {
  const override = env.SPOR_DISPATCH_RUNNER_CMD;
  if (!override) return { cmd: process.execPath, args: [DISPATCH_RUNNER] };
  if (/\.js$/i.test(override)) return { cmd: process.execPath, args: [override] };
  return { cmd: override, args: [] };
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

// One argv entry as `--print` should show it: the launcher-supplied
// placeholders read as what they stand for, everything else shell-quoted.
// Resolve the launcher-supplied placeholders in one argv entry.
//
// `embedded` is the DECLARED-harness mode: a hand-authored argv template may
// legitimately put a placeholder inside a larger argument (`--dir={cwd}` is a
// single argument to plenty of CLIs), so substitution is by substring. Every
// in-code adapter emits a placeholder as a WHOLE entry, and they keep the
// original equality test — not merely because it is equivalent for them, but
// because substring substitution would ALSO rewrite a placeholder appearing in
// a value the adapter did not put there (a graph-supplied `profile.model`
// spelling `__SPOR_CWD__` verbatim), which is a path disclosure the equality
// test cannot produce (norm-cc-byte-identical-refactor).
function substitutePlaceholders(arg, { report, cwd, embedded = false }) {
  if (!embedded) {
    if (arg === dispatchHarnesses.REPORT_PLACEHOLDER) return report;
    if (arg === dispatchHarnesses.CWD_PLACEHOLDER) return cwd;
    return arg;
  }
  let out = String(arg);
  if (out.includes(dispatchHarnesses.REPORT_PLACEHOLDER)) out = out.split(dispatchHarnesses.REPORT_PLACEHOLDER).join(report);
  if (out.includes(dispatchHarnesses.CWD_PLACEHOLDER)) out = out.split(dispatchHarnesses.CWD_PLACEHOLDER).join(cwd);
  return out;
}

// One argv entry as `--print` should show it. A whole-entry placeholder reads
// as what it stands for, unquoted — that is the shipped preview. An EMBEDDED
// one (declared harnesses only) is rendered and then shell-quoted like any
// other argument: the preview line is something people paste, so `--dir=<dir>`
// must not come back unquoted just because it contains a substitution.
function renderLaunchArg(arg, { embedded = false } = {}) {
  const whole = substitutePlaceholders(arg, { report: "<report-path>", cwd: "<dir>" });
  if (whole !== arg) return whole;
  if (!embedded) return shellQuote(arg);
  return shellQuote(substitutePlaceholders(arg, { report: "<report-path>", cwd: "<dir>", embedded: true }));
}

// The supervisor→launcher launch handshake (task-spor-dispatch-launch-
// handshake): the launcher gives the spawned supervisor a dedicated pipe (fd
// 3, wired via SPOR_DISPATCH_HANDSHAKE_FD) that the supervisor writes one
// JSON line to the moment it KNOWS whether the harness child started — not
// when the run record happens to catch up. This resolves as soon as that
// line arrives (or the channel closes, or the supervisor's own spawn errors),
// so launch success/failure is SIGNALED, not inferred from a fixed poll
// window racing an unrelated async write (dec-spor-dispatch-terminal-state-
// outcome-layer's provisional record write is a good-enough safety net, but a
// timing coincidence is not a contract). `timeoutMs` is a genuine last-resort
// bound for a supervisor that never signals at all — not a poll interval.
function awaitLaunchHandshake(stream, timeoutMs) {
  return new Promise((resolve) => {
    if (!stream) { resolve({ kind: "no-channel" }); return; }
    let buf = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onClosed);
      stream.removeListener("close", onClosed);
      stream.removeListener("error", onClosed);
      try { stream.destroy(); } catch { /* already gone */ }
      resolve(result);
    };
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      let msg = null;
      try { msg = JSON.parse(buf.slice(0, nl)); } catch { /* falls through to "unusable" */ }
      if (msg && typeof msg === "object") finish({ kind: "signal", ok: !!msg.ok, error: msg.error || null });
      else finish({ kind: "unusable" });
    };
    // The channel closing with no line ever parsed means the supervisor died
    // (or never wired the handshake, e.g. a test-seam override) before it
    // could signal either way — the caller falls back to the honest process
    // check for that case, exactly as it did before this handshake existed.
    const onClosed = () => finish({ kind: "channel-closed" });
    // Deliberately left ref'd: this wait is the launcher's whole reason to
    // stay alive right now (the CLI process has nothing else pending, since
    // the spawned child itself was already unref'd) — an unref'd timer/stream
    // here would let the event loop drain and the process exit with an
    // unresolved `await`, silently treating a still-pending handshake as
    // success.
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    stream.on("data", onData);
    stream.on("end", onClosed);
    stream.on("close", onClosed);
    stream.on("error", onClosed);
  });
}

async function launchSupervisedHarness(cfg, {
  adapter, command, args, cwd, name, nodeId, prompt, server, localNodesDir, childToken, mcpToken, bindToken,
  renewToken, renewNode, releaseNode, project, readOnly = false,
}) {
  const runId = crypto.randomUUID();
  const p = dispatchRuns.runPaths(cfg.userConfigHome(), runId);
  const embedded = !!adapter.declaration;
  const runArgs = args.map((a) => substitutePlaceholders(a, { report: p.report, cwd, embedded }));
  const now = new Date().toISOString();
  const record = {
    run_id: runId,
    node_id: nodeId || null,
    name,
    harness: adapter.id,
    launch_mode: adapter.launchMode,
    state: "launching",
    cwd,
    created_at: now,
    log_path: p.log,
    report_path: p.report,
  };
  dispatchRuns.pruneRuns(cfg.userConfigHome(), { maxAgeMs: cfg.getNum("dispatch.runRetentionMs", 1209600000) });
  writePrivate(p.prompt, prompt);
  writePrivate(p.job, JSON.stringify({
    run_id: runId,
    harness: adapter.id,
    command,
    args: runArgs,
    cwd,
    record_path: p.record,
    prompt_path: p.prompt,
    // Present only for a DECLARED harness (dispatch.harness.<id>): the
    // supervisor has no registry entry to look up, so it rebuilds the adapter
    // from exactly the declaration this launch resolved.
    ...(adapter.declaration ? { harness_declaration: adapter.declaration } : {}),
    // Present only under `--read-only`: the supervisor hands the adapter's
    // posture to its `prepareRun` so the part of it that lives in the
    // ENVIRONMENT (OpenCode's bash denial) is applied to the child too.
    ...(readOnly ? { read_only: true } : {}),
    log_path: p.log,
    report_path: p.report,
    scratch_path: p.scratch,
    server: server || null,
    // Present only when there is no server (task-spor-work-local-mode-
    // resolver-check): local dispatch has no `/v1/nodes/{id}` to verify a
    // resolution against, but it does have this run's own local graph home,
    // resolved by the LAUNCHER the same way `spor get`/`spor next` would —
    // not re-derived by the detached supervisor from its own cwd, which may
    // differ from the launching one.
    local_nodes_dir: server ? null : localNodesDir || null,
    renew_node: renewNode || null,
    // The terminal-state contract's inputs (task-spor-dispatch-terminal-states-
    // contract): the node to verify a resolving edge on and file the report
    // against, the project to stamp that report artifact with, and — separately
    // — the lease this invocation established and may therefore hand back. A
    // `--force` re-dispatch renews someone else's live lease, so `renew_node`
    // is deliberately NOT the release gate.
    node_id: nodeId || null,
    release_node: releaseNode || null,
    project: project || null,
  }, null, 2) + "\n");
  dispatchRuns.atomicJson(p.record, record);

  const runnerEnv = u.gitEnv();
  for (const key of [
    "SPOR_DISPATCH_CHILD_TOKEN", "SPOR_DISPATCH_MCP_TOKEN",
    "SPOR_DISPATCH_BIND_TOKEN", "SPOR_DISPATCH_RENEW_TOKEN",
  ]) delete runnerEnv[key];
  if (childToken) runnerEnv.SPOR_DISPATCH_CHILD_TOKEN = childToken;
  if (mcpToken) runnerEnv.SPOR_DISPATCH_MCP_TOKEN = mcpToken;
  if (bindToken) runnerEnv.SPOR_DISPATCH_BIND_TOKEN = bindToken;
  if (renewToken) runnerEnv.SPOR_DISPATCH_RENEW_TOKEN = renewToken;
  // fd 3 is the handshake channel (see awaitLaunchHandshake above); told apart
  // from the ordinary stdio fds by the env var so a supervisor that doesn't
  // know about it (an old build, or a test-seam override) simply never writes
  // there instead of writing garbage to whatever fd 3 happens to be.
  runnerEnv.SPOR_DISPATCH_HANDSHAKE_FD = "3";
  let child;
  let spawnError = null;
  // Resolved the instant the supervisor process itself fails to spawn (a
  // failure of `spawn(runner.cmd, ...)`, distinct from the harness child IT
  // spawns) — a permanent listener so a later `error` on this child, after the
  // handshake wait below has moved on, never becomes an unhandled-error crash.
  let notifySpawnError = () => {};
  const spawnErrorPromise = new Promise((resolve) => { notifySpawnError = resolve; });
  try {
    const runner = dispatchRunnerCommand();
    child = spawn(runner.cmd, [...runner.args, p.job], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "pipe"],
      env: runnerEnv,
      windowsHide: true,
    });
    child.on("error", (e) => { spawnError = e; notifySpawnError(e); });
    child.unref();
    if (child.pid) {
      // The tick count pins WHICH process pid `child.pid` is right now, so a
      // later pid-alive check that finds a different process (the kernel
      // reused the pid) can be told apart from a genuinely long-lived
      // supervisor (issue-spor-dispatch-supervisor-identity-stale-timeout).
      const startTicks = dispatchRuns.processStartTicks(child.pid);
      dispatchRuns.atomicJson(p.record, {
        ...record, runner_pid: child.pid,
        ...(startTicks != null ? { runner_started_ticks: startTicks } : {}),
      });
    }
  } catch (e) {
    spawnError = e;
  }

  // The record is already open at `launching`, and a supervisor that never
  // started will never close it — so the launcher closes it here, or the run
  // reads as live until reconciliation ages it out
  // (issue-spor-dispatch-supervised-runs-never-reconciled).
  const abandon = (signal, reason, error = reason) => {
    for (const f of [p.job, p.prompt]) try { fs.unlinkSync(f); } catch {}
    dispatchRuns.closeRun(p.record, dispatchRuns.launchFailure(reason, signal), "launching");
    return { ok: false, error, runId, paths: p };
  };
  if (spawnError) {
    // The caller's message keeps the bare spawn error it always reported; the
    // record keeps the self-contained sentence, since nothing else explains it.
    return abandon("supervisor-spawn-failed", `the ${adapter.label} supervisor could not be started: ${spawnError.message}`, spawnError.message);
  }

  const signal = await Promise.race([
    awaitLaunchHandshake(child.stdio && child.stdio[3], cfg.getNum("dispatch.launchHandshakeTimeoutMs", 5000)),
    spawnErrorPromise.then((e) => ({ kind: "spawn-error", error: e })),
  ]);
  if (signal.kind === "spawn-error") {
    return abandon("supervisor-spawn-failed", `the ${adapter.label} supervisor could not be started: ${signal.error.message}`, signal.error.message);
  }
  if (signal.kind === "signal") {
    if (signal.ok === false) {
      // The supervisor said so directly — no need to wait on the record write
      // the terminal-state contract makes beside it. But some failures (an
      // invalid job file, an unrecognized harness adapter) are caught before
      // the supervisor ever touches the record at all, so it would otherwise
      // sit at `launching` forever; abandon() closes it here too. `closeRun`
      // guards on `fromState`/TERMINAL_STATES, so this is a harmless no-op on
      // the paths where the supervisor's own contract also closes it.
      const msg = signal.error || `${adapter.label} process failed to launch`;
      return abandon("supervisor-reported-failure", `the ${adapter.label} supervisor reported a launch failure: ${msg}`, msg);
    }
    const state = dispatchRuns.readJson(p.record) || record;
    return { ok: true, state, runId, paths: p };
  }
  // "channel-closed" / "timeout" / "unusable" / "no-channel": the supervisor
  // never confirmed the launch over the handshake at all — fall back to the
  // honest process check. `child.exitCode`/`signalCode` are the honest test: a
  // detached child stays reaped-and-tracked by this process, so a bare pid
  // probe would read a zombie as alive. A crashed supervisor closes its fd 3
  // as PART OF exiting, so "channel-closed" can win this race before Node has
  // finished setting exitCode/signalCode — give the child's own `close` a
  // short, bounded beat to land (it always follows stdio closing) rather than
  // reading a not-yet-updated exitCode as "still alive".
  if (signal.kind === "channel-closed" && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
  const state = dispatchRuns.readJson(p.record) || record;
  if (state.state === "launching" && child && (child.exitCode !== null || child.signalCode !== null)) {
    const how = child.signalCode ? `on ${child.signalCode}` : `with code ${child.exitCode}`;
    return abandon("supervisor-exited-early", `the ${adapter.label} supervisor exited ${how} before reporting its child started`);
  }
  return { ok: true, state, runId, paths: p };
}

// --- spor runs (inc-spor-dispatch-session-vanished-2026-07-18) --------------
// The queryable terminal record for dispatched runs. Reading it RECONCILES
// first: a dispatched run's ending is invisible to the launcher, so its outcome
// is derived here — a native-background run from the harness's live-agent list
// plus its own transcript, a supervised one from its supervisor process plus
// its own log — and written back, after which the run has a durable terminal
// state, a classification, a reason, and a diagnostic pointer, whatever
// happened to it. No LLM and no network: a live-agent listing, a directory
// read, a pid probe, and a bounded file tail.
//
// Only the live-agent listing can fail, and it is only the native path's
// evidence — hence `enumerated` gating that path alone, and the listing being
// taken only when a non-terminal native record exists to spend it on
// (nativeAgentEvidence).
function cmdRuns(cfg, { values, positionals: pos }) {
  const home = cfg.userConfigHome();
  const { agents, enumerated } = nativeAgentEvidence(cfg, dispatchRuns.readRunRecords(home));
  const records = dispatchRuns.reconcileRuns(home, { agents, enumerated });
  const limit = Math.max(1, parseInt(values.limit, 10) || 20); // a bad --limit falls back to the default, never to 1
  const runs = dispatchRuns.listRuns(home, { records, node: values.node || null, runId: pos[0] || null, limit });
  // `reconciled` is the honest claim "every run here was resolved against live
  // evidence" — HERE meaning the runs THIS CALL is actually returning, so a
  // `--node`/runId-filtered query is judged only by what it shows, not by an
  // unrelated stale native run elsewhere in the store that isn't even in `runs`.
  // A failed agent listing only strands NATIVE runs, and only if any non-terminal
  // one is among the ones shown — supervised runs never needed that listing, so
  // a Codex-only box reports reconciled even with no `claude` to enumerate.
  const nativeStale = !enumerated && runs.some(
    (r) => r.launch_mode === "native-background" && !dispatchRuns.TERMINAL_STATES.has(r.state)
  );
  if (values.json) {
    out(JSON.stringify({ reconciled: !nativeStale, count: runs.length, runs }, null, 2));
    return 0;
  }
  if (!runs.length) {
    out("no dispatch runs recorded" + (values.node || pos[0] ? " for that filter" : "") + ".");
    return 0;
  }
  if (nativeStale) err("note: could not list live background agents — native run states may be stale (they were not reconciled).");
  for (const r of runs) {
    const cls = r.termination_class ? ` — ${r.termination_class}${r.termination_signal ? `/${r.termination_signal}` : ""}` : "";
    out(`${r.run_id.slice(0, 8)}  ${r.state}${cls}  ${r.node_id || r.name || "(free-text)"}  ${r.harness}  ${r.created_at || ""}`);
    // The OUTCOME, kept visibly apart from the process `state` above: what the
    // run did to the graph, and whether anyone verified it
    // (task-spor-dispatch-terminal-states-contract). `unenforced` is a
    // first-class label, never omitted — a best-effort classification must not
    // read like a checked one.
    if (r.terminal_state) {
      out(`  outcome:    ${r.terminal_state}${r.terminal_enforced ? "" : " (unenforced)"}${r.resolved_by ? ` by ${r.resolved_by}` : ""}`);
      if (r.terminal_note) out(`  note:       ${r.terminal_note}`);
      if (r.report_node_id) out(`  artifact:   ${r.report_node_id}`);
      if (r.lease_released === false && r.terminal_enforced && r.node_id) {
        out(`  lease:      still held — release it with 'spor release ${r.node_id}'`);
      }
    }
    if (r.termination_reason) out(`  why:        ${r.termination_reason}`);
    // The gate pipeline's own state on THIS run, when a factory-armed worker
    // gated it (task-spor-work-gate-pipeline). `gate_fix_run_id` names a fix
    // cycle this run's pipeline dispatched — surfaced whenever it is set, not
    // only on 'interrupted': it is exactly the run a stop leaves orphaned, and
    // 'spor runs <that id>' is how a human (or a restarted 'spor work') finds
    // out whether it is still going.
    if (r.gate_state) out(`  gate:       ${r.gate_state}${r.gate_reason ? ` — ${r.gate_reason}` : ""}`);
    if (r.gate_fix_run_id) {
      out(`  fix cycle:  run ${String(r.gate_fix_run_id).slice(0, 8)} — 'spor runs ${r.gate_fix_run_id}' follows it${r.gate_state === "interrupted" ? " (left running by a stopped worker)" : ""}`);
    }
    if (r.child_reaped) out(`  reaped:     an orphaned harness child was terminated at reconciliation`);
    if (r.cwd) out(`  cwd:        ${r.cwd}`);
    if (r.session_id) out(`  session:    ${r.session_id}`);
    if (r.transcript_path) out(`  transcript: ${r.transcript_path}`);
    if (r.log_path) out(`  log:        ${r.log_path}`);
    if (r.report_path) out(`  report:     ${r.report_path}`);
  }
  return 0;
}

// `ctx.onLaunch({run_id, harness, launch_mode, node_id, record_path})` is the
// only thing a programmatic caller (`spor work`, task-spor-work-loop) needs
// that the exit code cannot carry: WHICH run this dispatch started, so the
// caller can follow that run to its terminal state. It is called once, at the
// launch that succeeded, on both launch modes; a plain CLI dispatch passes no
// ctx and is unaffected.
// The built-in harnesses that can keep `--read-only`, and how — for the
// refusal message when a dispatch names one that cannot.
function harnessReadOnlyPostures() {
  const out = [];
  for (const a of dispatchHarnesses.harnesses ? dispatchHarnesses.harnesses() : []) {
    const ro = a.readOnly;
    if (!ro) continue;
    const how = ro.sandbox ? `--sandbox ${ro.sandbox}` : ro.permissionMode ? `--permission-mode ${ro.permissionMode}` : ro.agent ? `--agent ${ro.agent}` : Array.isArray(ro.denyTools) ? ro.denyTools.map((t) => `--deny-tool ${t}`).join(" ") : "declared";
    out.push(`${a.id} (${how})`);
  }
  return out.join(", ") || "none";
}

async function cmdDispatch(cfg, { values, positionals: pos }, ctx = null) {
  const dryRun = !!(values.print || values["dry-run"]);
  const full = !!values.full;
  const noBrief = !!values["no-brief"];
  const noClaim = !!values["no-claim"];
  const force = !!values.force;
  const backfill = !!values.backfill;
  const fromQueue = !!values["from-queue"];
  const dirOpt = values.dir || null;
  const model = values.model || null;
  let permMode = values["permission-mode"] || null;
  let sandbox = values.sandbox || null;
  const readOnly = !!values["read-only"];
  const approvalPolicy = values["approval-policy"] || null;
  const agent = values.agent || null; // claude --agent (harness agent DEFINITION)
  const asAgent = values.as || null; // Spor agent IDENTITY override for dispatch.agent
  // The escape hatch for dec-spor-worker-strictness-split-interactive-lenient:
  // by default a remote dispatch with no agent identity (below) hard-fails
  // rather than silently attributing agent writes to the person. This flag (or
  // its standing config twin) restores the old fail-soft, for solo/local use
  // where nobody has run `spor agent use` and that's fine.
  const allowPersonToken = !!values["allow-person-token"] || cfg.getBool("dispatch.allowPersonToken", false);
  // A user-supplied prompt template (task-spor-dispatch-user-prompt-templates):
  // --template wins, else a personal default in the config cascade
  // (dispatch.template — an absolute path, like dispatch.repos). Empty until we
  // resolve the file below, so an absent option leaves the prompt byte-identical.
  const templateOpt = values.template || cfg.get("dispatch.template", null);
  let nodeId = values.node || null;
  let targetSlug = values.slug || null;
  let name = values.name || null;
  let profileFlag = values.profile || null;
  let dispatchNodeRaw = null; // the dispatched node's markdown — read for its assigned->agent profile

  // Positional task text: parseArgs already split flags from positionals.
  let taskText = pos.join(" ").trim();

  // Load the template now (before any briefing compile) so a bad path fails fast.
  let template = null;
  if (templateOpt) {
    try {
      template = fs.readFileSync(path.resolve(templateOpt), "utf8");
    } catch (e) {
      err(`could not read --template ${templateOpt}: ${e.message}`);
      return 1;
    }
  }

  let brief = "";
  let instruction = "";
  let nodeTitle = "";
  let nodeSummary = "";
  let nodeType = "";
  let nodeStatus = "";
  let nodeDate = "";
  let resolvedReason = null; // set in node mode when the target is already resolved
  let readinessCheck = null; // set in node mode: {readiness, reasons} — the agent-readiness guard

  if (fromQueue) {
    const top = await topQueueItem(cfg, targetSlug);
    if (!top || !top.id) {
      err("queue empty — nothing to dispatch");
      return 1;
    }
    nodeId = top.id;
    targetSlug = targetSlug || top.repo || top.project || null;
    // Auto-route by the item's own `profile:` frontmatter (task-spor-test-
    // change-lane-auto-routing) — the same one-line fallback `spor work`'s
    // dispatchWorkItem applies, so `--from-queue`'s "pick the top item and
    // dispatch it" doesn't quietly skip profile resolution for an item with
    // no `assigned -> agent` edge (resolveDispatchProfile finds nothing to
    // resolve without one). An explicit --profile still wins.
    if (!profileFlag && top.profile) profileFlag = top.profile;
  }

  if (backfill) {
    // Onboarding a (possibly thin) repo: dispatch the skill; no briefing to compile.
    instruction = taskText ? `/spor:backfill\n\n${taskText}` : "/spor:backfill";
    name = name || "spor-backfill";
  } else if (!nodeId && pos.length === 1 && /^[a-z0-9]+(-[a-z0-9]+)+$/.test(pos[0])) {
    // Auto-detect: a single hyphenated token that resolves to a node => node mode.
    const maybe = await resolveNode(cfg, pos[0]);
    if (maybe) {
      nodeId = maybe.id;
      taskText = "";
    }
  }

  if (!backfill && nodeId) {
    const node = await resolveNode(cfg, nodeId);
    if (!node) {
      err(`no such node: ${nodeId}`);
      return 1;
    }
    dispatchNodeRaw = node.raw || null;
    targetSlug = targetSlug || node.repo || null;
    nodeTitle = node.title || "";
    nodeSummary = node.summary || "";
    nodeType = node.type || "";
    nodeStatus = node.status || "";
    nodeDate = node.date || "";
    resolvedReason = dispatchResolutionReason(cfg, node);
    readinessCheck = dispatchReadinessCheck(cfg, node);
    if (!noBrief) brief = await compileBriefing(cfg, { nodeId, full, project: targetSlug });
    instruction = `Work on ${nodeId}${node.title ? ` — ${node.title}` : ""}. The compiled Spor briefing above is your standing context.${taskText ? ` ${taskText}` : ""}`;
    name = name || nodeId;
  } else if (!backfill) {
    if (!taskText) {
      err('usage: spor dispatch "<task>" | --node <id> | --from-queue | --backfill');
      return 1;
    }
    if (!noBrief) brief = await compileBriefing(cfg, { query: taskText, full, project: targetSlug });
    instruction = taskText;
    name = name || taskText.split(/\s+/).slice(0, 8).join(" ").slice(0, 60);
  }

  const res = resolveDir(cfg, { dir: dirOpt, slug: targetSlug });
  if (!res.dir) {
    err(`don't know where '${res.slug}' lives on this machine.`);
    err(`  run 'spor dispatch' from inside that repo once (it self-registers), then re-run, or:`);
    err(`  spor repos add ${res.slug} <path>`);
    err(`  or pass --dir <path>.`);
    return 1;
  }
  if (!fs.existsSync(res.dir)) {
    err(`target dir does not exist: ${res.dir}`);
    return 1;
  }
  // Guard a CORRUPT dispatch.repos mapping (issue-spor-dispatch-repos-corruption-
  // worktree-session-start). The slug->path map is machine-local and a
  // session-start re-probe from a confused worktree cwd could have pointed this
  // slug at the WRONG checkout (e.g. spor-server -> the client repo), so the
  // agent would run against a tree that lacks the node's files and "complete"
  // with zero commits. Only the map-resolved branch is suspect (source "config")
  // — an explicit --dir or a cwd resolution is the caller's own pin and is
  // trusted. We can only authoritatively name a checkout's identity when it IS a
  // git work tree (`--is-inside-work-tree` prints the literal "true"/"false", so
  // match the string — a bare repo prints "false" with exit 0); a non-git target
  // has no authoritative slug, so we trust the map there (and `spor repos add` to
  // an arbitrary path stays valid). dirHostsSlug() accepts both the checkout's
  // own root slug AND a monorepo subtree marker that legitimately pins the slug
  // (my-api -> the shared root), so only a genuine cross-repo mismatch trips the
  // guard: refuse loudly with remediation. --force overrides.
  const dirIsWorkTree = (u.git(res.dir, ["rev-parse", "--is-inside-work-tree"]) || "").trim() === "true";
  if (res.source === "config" && dirIsWorkTree && !dirHostsSlug(res.dir, res.slug)) {
    err(`dispatch.repos['${res.slug}'] points at ${res.dir}, but that checkout is '${u.projectSlug(res.dir)}', not '${res.slug}' (and hosts no '${res.slug}' subtree).`);
    if (!force) {
      err(`  the slug→path map is corrupt (likely a session-start re-probe from a worktree cwd); dispatching there`);
      err(`  would run ${nodeId || name} against the wrong repo. Fix it with 'spor repos add ${res.slug} <correct-path>'`);
      err(`  (or add a '.spor' marker pinning 'repo: ${res.slug}' to that checkout), or pass --dir <path>.`);
      err(`  re-run with --force to dispatch into the mismatched checkout anyway.`);
      return 1;
    }
    err(`  --force set — dispatching into the mismatched checkout anyway.`);
  }
  // A node / --from-queue dispatch targets a SPECIFIC node that belongs to a
  // SPECIFIC repo, and the agent must run in THAT repo so its workspace hooks
  // apply — not the launcher's (issue-spor-dispatch-from-queue-wrong-repo-hooks).
  // The happy path resolves the target repo from the node's repo/project stamp
  // through the dispatch.repos map (res.source "config"), and an unknown stamp
  // already errors loudly above (res.dir null). The remaining hole is a node that
  // carries NO repo/project stamp: targetSlug stays null, so resolveDir silently
  // falls back to the launcher's cwd (res.source "cwd") and the launcher's hooks
  // would run against another repo's work. Refuse it loudly here, mirroring the
  // unknown-slug error, rather than mis-targeting in silence. An explicit --dir/
  // --slug moves res.source off "cwd" (the caller pinned it on purpose), and
  // free-text / --backfill dispatch legitimately targets the cwd (no nodeId), so
  // both keep working — only a stampless node-mode dispatch is caught.
  if (nodeId && !backfill && res.source === "cwd") {
    err(`can't tell which repo ${nodeId} belongs to — it carries no repo/project stamp,`);
    err(`  so dispatch would fall back to the launcher's cwd (${res.dir}) and apply ITS`);
    err(`  workspace hooks to another repo's work. Pin the target explicitly:`);
    err(`  pass --dir <path> (use --dir . if ${nodeId} really is for this repo),`);
    err(`  or --slug <repo> with 'spor repos add <repo> <path>', or add a repo:/project: stamp to ${nodeId}.`);
    return 1;
  }

  // Worktree isolation. Run the agent in its own worktree off res.dir so parallel
  // dispatches never collide on the shared tree/index. Resolution, highest wins:
  //   --no-worktree > --worktree > TARGET repo .spor.json dispatch.worktree >
  //   standing cfg dispatch.worktree > off.
  // The TARGET repo's own .spor.json wins over the standing user/global config so
  // a repo that declares it wants isolation is honored wherever it's dispatched
  // FROM. Forced off for --backfill, which sets up the MAIN checkout itself. The
  // setup hook follows the same target-first precedence; relative paths in the
  // marker resolve against the repo (the spor-server hook stages the
  // node_modules symlink + $SPOR_LIB the bare worktree needs).
  //
  // The "standing cfg" fallback must NOT be `cfg` as-is: `cfg` is anchored at
  // the DISPATCHER's cwd (process.cwd()), so its repo-.spor.json layer is the
  // LAUNCHER's own repo config, not the target's. Cross-repo dispatch (launch
  // from repo A for a node targeting repo B) would then apply repo A's
  // dispatch.worktreeSetup — a path relative to A — inside B's fresh worktree,
  // where it doesn't exist (issue-spor-dispatch-worktree-setup-wrong-repo-
  // config). Re-resolving the cascade anchored at res.dir instead fixes this:
  // it still picks up target's own .spor.json (redundant with targetCfg above,
  // but harmless) and the location-independent user/global config layers, while
  // never seeing a foreign repo's .spor.json.
  const targetCfg = targetRepoDispatchCfg(res.dir);
  const targetStandingCfg = loadConfig({ cwd: res.dir, env: process.env });
  // `worktreeSetup` here is a --print PREVIEW ONLY (line ~7855 below), read
  // from the main checkout's live files since no worktree exists yet to read
  // it from. The REAL dispatch never uses this value: createDispatchWorktree
  // re-resolves dispatch.worktreeSetup from the freshly-created worktree's own
  // checkout instead, so a stale/dirty main index at dispatch time can't
  // silently no-op the hook (issue-spor-dispatch-worktree-config-live-file-race).
  const worktreeSetup =
    targetCfg.worktreeSetup != null ? targetCfg.worktreeSetup : targetStandingCfg.get("dispatch.worktreeSetup", null);
  const worktreeDefault =
    targetCfg.worktree != null ? targetCfg.worktree : !!targetStandingCfg.get("dispatch.worktree", false);
  const useWorktree =
    !backfill && (values["no-worktree"] ? false : !!(values.worktree || worktreeDefault));

  // Session project (issue-spor-dispatch-propagate-session-project-to-questions).
  // The launcher env never reaches a native `claude --bg` agent (it self-allocates
  // a spare worker; dec-spor-session-identity-active-record), and the agent token
  // carries only {agent, session} — NOT the project. So the one channel the session
  // project rides to the agent in every launch mode is the prompt itself: state it, and
  // tell the agent to pass it as ask_question's `project` param when a question
  // has no clear `mentions:`. The server gives that explicit project precedence
  // over its mentions/neighborhood derivation, closing the residual mention-less,
  // no-match case that otherwise mis-stamps the question into the asker's home
  // project. res.slug is the project this dispatch resolved into (always set —
  // resolveDir falls back to the cwd slug). Omitted from a --template prompt,
  // which exposes the same value as {{slug}}/{{project}} and takes over entirely.
  const sessionNote = res.slug
    ? `> **Spor session project:** \`${res.slug}\`. If you file a question with ` +
      `\`ask_question\` (or \`POST /v1/questions\`) that has no clear \`mentions:\`, pass ` +
      `\`project: "${res.slug}"\` so it is stamped to this project rather than ` +
      `defaulting to the asker's home project.\n\n`
    : "";
  const defaultPrompt = brief
    ? `${sessionNote}# Spor briefing (compiled for this task — your standing context)\n\n${brief}\n\n---\n\n# Task\n\n${instruction}\n`
    : `${sessionNote}${instruction}`;

  // With no template the launched prompt adds only the session-project note above
  // (issue-spor-dispatch-propagate-session-project-to-questions). A template takes
  // over entirely: it decides where the compiled brief, the task, and the node
  // metadata land (or wraps the whole default via {{default}}).
  let prompt = defaultPrompt;
  if (template != null) {
    const r = renderTemplate(template, {
      brief, briefing: brief, neighbourhood: brief, neighborhood: brief,
      task: instruction, instruction,
      node: nodeId || "", node_id: nodeId || "", id: nodeId || "",
      title: nodeTitle,
      summary: nodeSummary, type: nodeType, status: nodeStatus, date: nodeDate,
      slug: res.slug || "", project: res.slug || "", repo: res.slug || "",
      dir: res.dir || "",
      default: defaultPrompt,
    });
    if (r.unknown.length) {
      err(
        `warning: unknown template placeholder(s): ${[...new Set(r.unknown)].join(", ")} ` +
          `(available: brief, task, node, id, title, summary, type, status, date, slug, dir, default)`
      );
    }
    prompt = r.text;
    // A WORKER's dispatch (ctx.carryTask — set by dispatchThrough beside
    // supervisedOnly) must reach the agent with its task text whatever the
    // template says: for `spor work` that text IS the worker contract, a fix
    // cycle's or a rescue's instructions, and the one-turn notice they all
    // carry (issue-spor-rescue-and-fix-sessions-end-turn-waiting-on-
    // background-job). `--template` rides the loop's passthrough and a
    // personal `dispatch.template` applies to every dispatch on the box, so a
    // template naming neither {{task}} nor {{default}} would silently launch
    // an unattended implementer with no contract at all — the bypass the
    // notice exists to close. A person's own `spor dispatch --template` keeps
    // the template's full authority (byte-identical); only a worker's launch
    // gets the task appended, and says so.
    if (ctx && ctx.carryTask && instruction && !prompt.includes(instruction)) {
      err(
        `warning: the prompt template omits {{task}} and {{default}}, so the worker's instructions (the contract and its` +
          ` one-turn notice) would not reach the agent — appending them after the rendered template`
      );
      prompt = `${prompt.replace(/\s+$/, "")}\n\n---\n\n# Task\n\n${instruction}\n`;
    }
  }

  // Same-machine duplicate-dispatch guard (task-spor-dispatch-same-machine-guard).
  // `spor dispatch` names each background agent after its node id, so an active
  // agent with this name means this person already has this node in flight on THIS
  // machine — a duplicate the auto-claim can't catch (a same-person re-claim is an
  // idempotent renew by design, dec-cc-task-claim-lease). dispatchedAgents() is the
  // same NO-LLM, fail-soft cross-reference `spor next --hide-dispatched` uses; node
  // mode only (mirrors the auto-claim's scope), in BOTH local and remote (it's a
  // local agent read, independent of the graph backend). claude absent / a stale
  // exit / unparseable output => empty => no guard (fail-open); --force overrides.
  const inFlight = nodeId && !backfill ? dispatchedAgents(cfg).get(name) || [] : [];

  // Session identity (dec-spor-dispatch-bg-session-late-bind). No harness lets
  // us pick the run session up front: the native `claude --bg` variant IGNORES
  // `--session-id` and self-allocates (verified — it warns and ignores the
  // flag), and a supervised run (`claude -p` stream-json, codex, …) announces
  // its session on its own stream. So we do NOT force one; the agent token is
  // minted session-DEFERRED and the real session is bound AFTER launch — read
  // off the supervised stream, or captured from `claude agents --json` for a
  // native run (rebind the token + renew the lease). SPOR_SESSION_ID pins the session for
  // tests/reproducibility (short-circuits the capture). `mcpKey` names the 0600
  // --mcp-config file — a fresh uuid, since the session id isn't available here.
  const pinnedSession = process.env.SPOR_SESSION_ID || null;
  const mcpKey = crypto.randomUUID();
  // This machine's agent node — the WHO a dispatched session runs as. `--as`
  // overrides the per-machine dispatch.agent default for this one dispatch. The
  // id must satisfy the SAME contract the server's token-mint endpoint enforces
  // (an 'agent-<slug>' kebab id) — an EXPLICIT --as that doesn't is a hard error
  // here, caught before any side effect rather than as a per-dispatch 422
  // (issue-spor-dispatch-agent-id-prefix-validation-gap). Only meaningful remotely
  // (the server is the CA that mints the agent token); a local-mode dispatch or an
  // unconfigured machine simply runs person-scoped.
  if (asAgent && !isAgentId(asAgent)) {
    err(`invalid --as agent id '${asAgent}' — must be an 'agent-<slug>' kebab id (e.g. agent-your-machine)`);
    const guess = agentIdGuess(asAgent);
    if (guess) err(`  did you mean '--as ${guess}'?  ('spor agent list' shows the full id — the 'agent-' prefix is part of it, not the label)`);
    return 1;
  }
  let identityAgent = cfg.mode() === "remote" ? (asAgent || dispatchAgentId(cfg)) : null;
  // A configured `dispatch.agent` (no --as) that isn't a valid agent id — e.g. the
  // agent's LABEL stored instead of its 'agent-'-prefixed NODE id — would 422 at
  // token-mint (issue-spor-dispatch-agent-id-prefix-validation-gap). Catch it here
  // with an actionable line rather than a round-trip to a 422 that names nothing.
  // Per dec-spor-worker-strictness-split-interactive-lenient this now HARD-FAILS
  // on a real run — a dispatch that can't resolve an agent identity must not
  // silently attribute agent writes to the person — unless --allow-person-token
  // (or dispatch.allowPersonToken) opts back into the old fail-soft. --print stays
  // a preview regardless (never fails here; the preview line below still shows
  // "person-scoped"). The explicit --as path already hard-errored above, so this
  // only fires for the config default.
  if (identityAgent && !isAgentId(identityAgent)) {
    const guess = agentIdGuess(identityAgent);
    if (!dryRun && !allowPersonToken) {
      err(`cannot dispatch ${nodeId || name}: configured dispatch.agent '${identityAgent}' is not a valid agent id.`);
      err(`  agent ids start with 'agent-'.${guess ? ` fix: spor agent use ${guess}` : ""}  ('spor agent list' shows your agents.)`);
      err(`  pass --allow-person-token to dispatch person-scoped instead (dispatch.allowPersonToken to make it standing).`);
      return 1;
    }
    err(`warning: configured dispatch.agent '${identityAgent}' is not a valid agent id — dispatching person-scoped${allowPersonToken ? " (--allow-person-token)" : ""}.`);
    err(`  agent ids start with 'agent-'.${guess ? ` fix: spor agent use ${guess}` : ""}  ('spor agent list' shows your agents.)`);
    identityAgent = null;
  }
  // An explicit --as can't take effect in local mode — there is no CA to mint the
  // agent token. Say so rather than silently dropping it to person-scoped.
  if (asAgent && cfg.mode() !== "remote") {
    err(`note: --as ${asAgent} ignored in local mode — agent-on-behalf-of attribution is remote-only`);
  }
  // No agent identity to dispatch under at all (no --as, no dispatch.agent
  // configured) — the other half of the same hard-fail: a remote dispatch with
  // nothing to mint a token FOR is exactly as much a silent person-attribution
  // as a mint failure, so it gets the same escape hatch. Local mode has no CA to
  // mint against in the first place and stays byte-identical (never reaches here
  // with identityAgent unset — see above).
  if (!dryRun && cfg.mode() === "remote" && !identityAgent && !allowPersonToken) {
    err(`cannot dispatch ${nodeId || name}: no dispatch agent configured for this machine.`);
    err(`  fix: spor agent use <agent-id>  ('spor agent create <label>' first if you have none yet; 'spor agent list' shows them.)`);
    err(`  or pass --allow-person-token to dispatch person-scoped anyway (dispatch.allowPersonToken makes it standing).`);
    return 1;
  }

  // Agent-readiness guard inputs (task-spor-dispatch-readiness-guard): computed
  // once, read by both the --print preview and the real-run refusal/warn below.
  // `requires: human` (readinessRequiresHuman) is the hard-refuse subset of the
  // broader `readiness: human` classification (readinessHuman) — see the
  // real-run guard for the distinction. Derived purely from readinessCheck
  // (already resolved from the node above), so it costs nothing to evaluate
  // before profile resolution below.
  const readinessHuman = !!(readinessCheck && readinessCheck.readiness === "human");
  const readinessRequiresHuman = readinessHuman && readinessCheck.reasons.includes("requires human");

  // Refuse the cheap, node-derived guards BEFORE profile resolution on a REAL run
  // (issue-spor-dispatch-probe-side-effect-before-refusal): resolveDispatchProfile
  // below calls probeCapabilities, which PERSISTS a machine-local capability probe
  // to disk once a profile resolves — a side effect a refused dispatch must not
  // cause. --print keeps the upfront compute-everything shape (it needs the
  // profile verdict to preview every guard, this one included), so the early
  // exit is real-run only; the --print branch below still resolves the profile
  // and reports each guard's would-refuse verdict for itself.
  if (!dryRun && resolvedReason && !force) {
    err(`${nodeId} is already resolved (${resolvedReason}) — not dispatching.`);
    err(`  re-run with --force to dispatch at it anyway, or pick another task with 'spor next'.`);
    return 1;
  }
  if (!dryRun && readinessRequiresHuman) {
    err(`cannot dispatch ${nodeId || name}: this item requires a human — ${readinessCheck.reasons.join(", ")}.`);
    err(`  the assignment is unchanged. A human must do this work (or edit the node's 'requires:' list once`);
    err(`  it no longer needs one), then dispatch again — a readiness stamp alone can't override it.`);
    return 1;
  }

  // Profile satisfiability (dec-spor-machine-profile-satisfiability, FORK B).
  // Resolve the profile this dispatch runs under (--profile > the node's
  // assigned->agent profile attr > the agent's default) and decide whether THIS
  // machine can launch it. The verdict feeds the --print preview below and a
  // hard refusal before any side effect in the real run. No profile resolved =>
  // byte-identical to before (the common case until profiles are in use).
  const profileCheck = await resolveDispatchProfile(cfg, { profileFlag, nodeRaw: dispatchNodeRaw, identityAgent });
  if (profileCheck && profileCheck.found === false) {
    // Explicit --profile we couldn't load (absent locally, or unfetchable
    // remotely). Refuse rather than launch under an unverifiable profile.
    err(`could not load profile ${profileCheck.id} (from ${profileCheck.source}).`);
    err(`  check the id with 'spor get ${profileCheck.id}', or drop --profile.`);
    return 1;
  }
  const unsatisfiable = !!(profileCheck && profileCheck.verdict && !profileCheck.verdict.ok);
  const profileRuntime = (profileCheck && profileCheck.profile) || {};
  const harness = profileRuntime.harness || "claude-code";
  // A graph write must never define what a machine executes
  // (task-spor-dispatch-declarative-custom-harness). A profile selects a
  // harness by NAME; the command, argv, environment and report/session
  // recovery behind that name are bound machine-locally. A profile carrying
  // any of those is refused outright — in --print too, so a preview never
  // shows a launch the real run would reject.
  const graphLaunch = sat.graphLaunchFields(profileRuntime);
  if (graphLaunch.length) {
    err(`cannot dispatch ${nodeId || name}: profile ${profileCheck && profileCheck.id ? profileCheck.id : harness} declares ${graphLaunch.map((k) => `'${k}'`).join(", ")}.`);
    err(`  a graph write must never define what a machine executes — a profile names a harness, and this`);
    err(`  machine binds what that name runs ('${sat.DECLARED_HARNESS_CONFIG_KEY}.<id>' in $SPOR_HOME/config.json).`);
    err(`  remove ${graphLaunch.length > 1 ? "those fields" : "that field"} from the profile node; the assignment is unchanged.`);
    return 1;
  }
  // Built-in adapter first; failing that, this machine's own declaration for
  // the id. A declaration that exists but is unusable is reported as ITS OWN
  // error rather than as "unsupported harness" — the operator wrote something,
  // and needs to know what is wrong with it.
  const harnessResolution = dispatchHarnesses.resolveHarness(harness, { cfg });
  let harnessAdapter = harnessResolution.adapter;
  if (harnessResolution.error && !dryRun) {
    err(`cannot dispatch ${nodeId || name}: this machine's declaration for harness '${harness}' is unusable.`);
    err(`  ${harnessResolution.error}`);
    err(`  fix it in $SPOR_HOME/config.json; the assignment is unchanged.`);
    return 1;
  }
  // Launch-mode opt-in (task-spor-claude-adapter-headless-supervised): every
  // built-in launches SUPERVISED by default, Claude Code included; `--bg` (or
  // a standing `dispatch.claudeLaunchMode: native-background`) swaps in the
  // adapter's native-background variant — `claude --bg`, the attachable
  // interactive run. An explicit `--bg` on a harness that has no such mode is
  // refused (silently ignoring a flag the operator passed is worse); the
  // standing knob only means anything for the harness that has one, so it is
  // a no-op elsewhere. A worker-loop dispatch (`spor work`'s implementer runs,
  // its agent-review gates and fix cycles — everything through
  // dispatchThroughLocked) passes `ctx.supervisedOnly` and ignores BOTH: the
  // loop needs the supervised arm's report channel and enforced outcome, and
  // a box-wide config knob must not silently turn every worker run into an
  // unenforced, report-less one. The knob is not SILENTLY ignored, though:
  // cmdWork says so once at worker start (task-spor-work-honor-claude-launch-
  // mode-and-retire-native-precheck).
  const configuredLaunchMode = cfg.get("dispatch.claudeLaunchMode", null) || null;
  if (configuredLaunchMode && !["supervised", "native-background"].includes(configuredLaunchMode)) {
    err(`warning: dispatch.claudeLaunchMode '${configuredLaunchMode}' is not recognized (supervised | native-background) — ignoring it.`);
  }
  const launchModeRequest = ctx && ctx.supervisedOnly ? null : (values.bg ? "native-background" : configuredLaunchMode);
  if (harnessAdapter && launchModeRequest) {
    const variant = dispatchHarnesses.launchVariant(harnessAdapter, launchModeRequest);
    if (variant) harnessAdapter = variant;
    else if (values.bg) {
      err(`cannot use --bg with a ${harnessAdapter.label} dispatch — only Claude Code has a native background (attachable) launch mode.`);
      err(`  drop --bg to run it under the supervisor, or pick a claude-code profile.`);
      return 1;
    }
  }
  const effectiveModel = model || profileRuntime.model || null;
  // Explicit-first launcher resolution (task-spor-dispatch-adapters-opencode-
  // copilot): the adapter consults its env override and `dispatch.bin.<harness>`
  // through the cascade before falling back to the bare name. With neither set
  // this is the same string it always returned.
  const harnessBin = harnessAdapter ? harnessAdapter.command(process.env, cfg) : null;
  // --read-only (task-spor-review-gate-stateful-bounded): the posture a gate's
  // REVIEW dispatch runs under — it reads the implementer's live checkout, so
  // it must not be able to write to it. Expressed per harness by the adapter
  // (Codex's --sandbox read-only, Claude Code's plan permission mode); it
  // OVERRIDES an explicit --sandbox/--permission-mode from the caller (a
  // worker's passthrough may carry a write-capable posture for its
  // implementers — that must not leak into its reviewers), with a warning so
  // the override is visible. A harness with NO read-only posture is REFUSED,
  // not warned about (review finding 3 on the first cut: a warning left the
  // reviewer write-capable on exactly the harnesses that had no posture yet):
  // `--read-only` is a promise the caller relies on, and a launch that cannot
  // keep it must not proceed as if it had. Every built-in adapter declares a
  // posture; a declared custom harness has none by v1 scope, so a review gate
  // has to route to a built-in one.
  if (readOnly && harnessAdapter) {
    const ro = harnessAdapter.readOnly || null;
    if (!ro) {
      err(`spor dispatch: --read-only cannot be enforced on ${harnessAdapter.label} — the harness declares no read-only posture, so the run would be write-capable.`);
      err(`  route the read-only run (a review gate's profile) to a harness that has one: ${harnessReadOnlyPostures()}.`);
      return 1;
    } else {
      if (ro.sandbox) {
        if (sandbox && sandbox !== ro.sandbox) err(`warning: --read-only overrides --sandbox ${sandbox} with --sandbox ${ro.sandbox}.`);
        sandbox = ro.sandbox;
        // A translated bypassPermissions would re-open the sandbox; the
        // explicit read-only posture wins over a passthrough bypass.
        if (permMode === "bypassPermissions") permMode = null;
      }
      if (ro.permissionMode) {
        if (permMode && permMode !== ro.permissionMode) err(`warning: --read-only overrides --permission-mode ${permMode} with --permission-mode ${ro.permissionMode}.`);
        permMode = ro.permissionMode;
      }
    }
  }
  // Validate BEFORE building any argv (preview or real) — a translated option
  // (today: Codex + --permission-mode bypassPermissions) changes what argv
  // buildArgs should see, so effectiveSandbox/effectiveApprovalPolicy below
  // must be resolved first and threaded through every buildArgs call site.
  const harnessOptionsCheck = harnessAdapter && harnessAdapter.validateOptions({
    permissionMode: permMode, agent, sandbox, approvalPolicy,
  });
  if (harnessOptionsCheck && harnessOptionsCheck.message) {
    err(harnessOptionsCheck.message);
    err(`  ${harnessOptionsCheck.hint}`);
    return 1;
  }
  if (harnessOptionsCheck && harnessOptionsCheck.warning) err(harnessOptionsCheck.warning);
  const translated = harnessOptionsCheck && harnessOptionsCheck.translate;
  const effectiveSandbox = (translated && translated.sandbox) || sandbox || "workspace-write";
  const effectiveApprovalPolicy = (translated && translated.approvalPolicy) || approvalPolicy || "never";
  // NB: no `--session-id` — `claude --bg` ignores it (warns) and manages its own
  // session; we capture the real one post-launch (dec-spor-dispatch-bg-session-late-bind).
  // The adapter's own read-only posture rides into buildArgs only under
  // --read-only, so a plain dispatch's argv is byte-identical.
  const readOnlyPosture = readOnly && harnessAdapter ? harnessAdapter.readOnly || null : null;
  const previewArgs = harnessAdapter ? harnessAdapter.buildArgs({
    name,
    model: effectiveModel,
    permissionMode: permMode,
    agent,
    sandbox: effectiveSandbox,
    approvalPolicy: effectiveApprovalPolicy,
    reportPath: dispatchHarnesses.REPORT_PLACEHOLDER,
    sporMcp: null,
    readOnly: readOnlyPosture,
  }) : [];
  const supportedHarness = !!harnessAdapter;
  // An UNSATISFIABLE profile is refused further down by the satisfiability path
  // instead, even when the harness is also unsupported here — that refusal
  // names the missing atom AND re-routes to a fleet host that has it, which is
  // strictly more useful for the case the two overlap on: a declared harness
  // nobody bound on THIS box (task-spor-dispatch-declarative-custom-harness).
  // This branch keeps the case satisfiability cannot catch — a harness DECLARED
  // as a capability (`spor capabilities set harnesses …`) that this client
  // still has no adapter or binding for.
  if (!supportedHarness && !dryRun && !unsatisfiable) {
    err(`cannot dispatch ${nodeId || name}: profile ${profileCheck && profileCheck.id ? profileCheck.id : "(unknown)"} selects unsupported harness '${harness}'.`);
    err(`  this client has adapters for ${dispatchHarnesses.harnesses({ cfg }).map((a) => a.id).join(", ")}; the assignment is unchanged.`);
    err(`  a harness with no built-in adapter runs only where its owner bound it — declare`);
    err(`  '${sat.DECLARED_HARNESS_CONFIG_KEY}.${harness}' (command, args, report, session) in $SPOR_HOME/config.json.`);
    return 1;
  }

  if (dryRun) {
    out(`dir:    ${res.dir}  (slug: ${res.slug}, via ${res.source})`);
    if (useWorktree) {
      out(
        `worktree: ${dispatchWorktreeDir(res.dir, name)}  (branch ${worktreeName(name)}, off HEAD)` +
          (worktreeSetup ? `; setup: ${worktreeSetup}` : `; no setup hook (dispatch.worktreeSetup unset)`)
      );
    }
    if (backfill) {
      const steps = [];
      if (cfg.mode() !== "remote") steps.push(fs.existsSync(cfg.nodesDir()) ? "graph home ready" : "init graph home");
      steps.push(`register ${res.slug} → ${res.dir}`);
      if (!cfg.enabled()) steps.push("re-enable repo (currently disabled)");
      out(`onboard: ${steps.join("; ")}`);
    }
    out(`brief:  ${brief ? `${brief.length} bytes` : "(none — graph had nothing relevant, or --no-brief/--backfill)"}`);
    if (profileCheck) out(`harness: ${harness} (profile ${profileCheck.id})`);
    out(`session: ${pinnedSession || (harnessAdapter ? harnessAdapter.sessionPreview : "(unsupported harness)")}`);
    // Identity preview: what the real dispatch would do for agent-scoping. The
    // token mint + 0600 mcp-config are SIDE EFFECTS, so --print only describes
    // them (it writes nothing and makes no network call here). Local mode and an
    // unconfigured machine read "person-scoped" — byte-stable but for the new
    // session line, which is additive and always present now.
    if (identityAgent) {
      const src = asAgent ? " (via --as)" : "";
      // The note is DECLARED by the adapter rather than branched on here, so a
      // new harness describes its own identity mechanism instead of falling
      // through to whichever branch it least resembles.
      const claudeNote = dispatchHarnesses.getHarness("claude-code").identityNote;
      out(`agent:  ${identityAgent}${src} ${(harnessAdapter && harnessAdapter.identityNote) || claudeNote}`);
    } else if (cfg.mode() === "remote") {
      out(
        `agent:  (none configured — 'spor agent use agent-<machine>' or --as to attribute as agent-on-behalf-of)` +
          (allowPersonToken
            ? " — dispatching person-scoped (--allow-person-token)"
            : " — real dispatch would REFUSE (pass --allow-person-token to dispatch person-scoped anyway)")
      );
    }
    // Already-resolved guard preview (node mode, any mode): a real dispatch would
    // refuse a target that is already done. Shown first — and only on a hit, so a
    // clean node --print stays byte-identical to before — mirroring the real-run
    // precedence below (the resolved guard is checked before the profile/in-flight ones).
    if (resolvedReason) {
      out(
        `resolved: ${nodeId} is already resolved (${resolvedReason})` +
          (force ? " — --force set, dispatching anyway" : " — real dispatch would refuse (--force overrides)")
      );
    }
    // Agent-readiness guard preview (shown only when the node's derived
    // readiness is decisively human, so a clean/agent-ready/untriaged --print
    // stays byte-identical). requires:human is the one reason with NO --force
    // override — the risk-class register, not a capability gap.
    if (readinessHuman) {
      out(
        `readiness: human — ${readinessCheck.reasons.join(", ")}` +
          (readinessRequiresHuman
            ? " — real dispatch would REFUSE (no --force override)"
            : " — real dispatch would warn and proceed")
      );
    }
    // Profile satisfiability preview (shown only when a profile resolves, so a
    // profile-free --print stays byte-identical). A real dispatch refuses when
    // UNSATISFIABLE, leaving the assignment intact.
    if (profileCheck && profileCheck.verdict) {
      const v = profileCheck.verdict;
      out(`profile: ${profileCheck.id} (via ${profileCheck.source}) — ${v.ok ? "satisfiable here" : "UNSATISFIABLE here; real dispatch would refuse"}`);
      for (const r of v.reasons) out(`  - ${r}`);
    }
    // Same-machine guard preview (node mode, any mode): a real dispatch would
    // refuse if an agent with this name is already in flight here. Shown only on a
    // hit, so a clean node --print stays byte-identical to before.
    if (inFlight.length) {
      out(
        `in-flight: ${name} already has ${inFlight.length} agent(s) in flight here` +
          (force ? " — --force set, dispatching anyway" : " — real dispatch would refuse (--force overrides)")
      );
    }
    // Auto-claim preview (remote node dispatch only — local mode has no lease, so
    // nothing is announced there and local --print stays byte-identical).
    if (nodeId && !backfill && cfg.mode() === "remote") {
      out(`claim:  ${noClaim ? "(--no-claim — lease not established)" : `would establish a lease on ${nodeId} at launch (session bound from the run after launch)`}`);
    }
    if (template != null) out(`template: ${path.resolve(templateOpt)}`);
    if (harnessResolution.error) out(`run:    (declaration for harness '${harness}' is unusable: ${harnessResolution.error})`);
    else if (!supportedHarness) out(`run:    (unsupported harness '${harness}')`);
    else if (harnessAdapter.launchMode === "supervised-jsonl") {
      out(`run:    ${harnessBin} ${previewArgs.map((a) => renderLaunchArg(a, { embedded: !!harnessAdapter.declaration })).join(" ")}  # prompt on stdin`);
    } else out(`run:    ${harnessBin} ${previewArgs.map(shellQuote).join(" ")} <prompt>`);
    out(`\n--- prompt ---\n${prompt}`);
    return 0;
  }

  // The already-RESOLVED guard and the requires:human agent-readiness guard both
  // already refused above (before profile resolution) on a real run — nothing
  // left to check here for those two. The broader `readiness: human`
  // classification (assigned to a person, a held task, an open neighborhood
  // question, or the item itself a question/capture) is not a capability gap and
  // was never a refusal — it only WARNS and the dispatch proceeds, so that check
  // stays here, after profile resolution, alongside the guards below it.
  if (readinessHuman) {
    err(`warning: ${nodeId || name}'s derived readiness is human, not agent — ${readinessCheck.reasons.join(", ")}.`);
    err(`  dispatching anyway; 'spor next' shows the same signal if you'd rather triage first.`);
  }

  // Refuse BEFORE any side effect if this machine can't satisfy the resolved
  // profile (dec-spor-machine-profile-satisfiability, FORK B): fail soft and
  // loud, leave the task assigned and its lease/queue state untouched, NEVER
  // substitute a different profile. The human/routine chose THIS profile; a box
  // that can't honour it re-routes, it doesn't silently downgrade. No --force
  // bypass — that would be the silent substitution this rule forbids.
  if (unsatisfiable) {
    err(`cannot dispatch ${nodeId || name} here: this machine can't satisfy profile ${profileCheck.id} (via ${profileCheck.source}).`);
    for (const r of profileCheck.verdict.reasons) err(`  - ${r}`);
    // Substitution-free re-routing CONSUMER (task-spor-fleet-scheduler-autoroute-
    // dispatch): instead of a dead-end "re-route somewhere" hint, consult the
    // fleet scheduler (GET /v1/profiles/{id}/hosts, art-spor-remote-fleet-
    // scheduler-shipped) and NAME the boxes that can satisfy THIS exact profile,
    // or — when none can — say so and escalate to the owner (FORK B: never
    // substitute a different profile). Remote-only and FAIL-SOFT: an
    // unreachable/undeployed scheduler falls through to the generic hint, so the
    // refusal still works offline and local mode stays byte-identical.
    const routed = cfg.mode() === "remote" ? await reportFleetHosts(cfg, profileCheck.id) : false;
    if (!routed) {
      err(`  the assignment is unchanged. Re-route to a machine that satisfies it, run 'spor capabilities' to`);
      err(`  declare/repair what's missing here, or pass a different --profile.`);
    }
    return 1;
  }

  // Refuse a same-machine duplicate BEFORE any side effect or claim
  // (task-spor-dispatch-same-machine-guard): no repo registration, no lease, no
  // launch for a node already in flight here. --force overrides.
  if (inFlight.length && !force) {
    err(`${name} already has a background agent in flight on this machine — not dispatching a duplicate.`);
    err(`  in flight: ${inFlight.map((a) => `${a.id || "?"}${a.state ? ` (${a.state})` : ""}`).join(", ")}`);
    err(`  re-run with --force to dispatch anyway, or 'spor next --json' to review what's already running.`);
    return 1;
  }

  // Side effects (real run only — --print writes nothing). --backfill is the
  // onboarding door, so it sets the repo up (init + enable) first; every
  // dispatch self-registers the dir it resolved.
  if (backfill) onboardRepo(cfg, res.dir);
  // The slug->path map is machine-local — written to the PERSONAL user config
  // home, never the (possibly marker-shared) graph home
  // (issue-spor-config-desync-shared-graph-home).
  u.registerRepo(cfg.userConfigHome(), res.slug, res.dir);
  if (backfill) out(`registered ${res.slug} → ${res.dir}; launching the backfill agent…`);

  // Preflight only the PATH route — a launcher naming no directory, whether it
  // is the adapter default or an explicitly configured bare name. A launcher
  // given as a PATH is left to the launch, whose own `could not launch <path>:
  // ENOENT` already names the exact path that was tried, and which releases the
  // claim this dispatch established; refusing it earlier would skip that.
  const binary = dispatchHarnesses.describeHarnessBin(harnessAdapter, { env: process.env, cfg });
  if (binary.onPath && !hasCmd(binary.command)) {
    err(binary.explicit
      ? `${binary.command} not found on PATH (${binary.source} names it) — install it, or give ${binary.source} an absolute path.`
      : `${harnessAdapter.missingBinary}, then re-run (or 'spor dispatch … --print' to see the prompt).`);
    return 1;
  }

  // Agent-scoped identity injection (dec-spor-session-identity-active-record,
  // the VERIFIED mechanism): mint a per-session agent-scoped token, write it into
  // a 0600 --mcp-config that exposes ONLY the agent's own Spor MCP, and add
  // --strict-mcp-config so the account connector is excluded by construction. The
  // server then stamps authored_by_agent + session from that token. The token is
  // minted session-DEFERRED — the run session isn't known until `claude --bg`
  // self-allocates it, so we bind it AFTER launch (dec-spor-dispatch-bg-session-
  // late-bind), keeping `agentToken` to authenticate that late bind. Per
  // dec-spor-worker-strictness-split-interactive-lenient a mint failure now HARD
  // FAILS — a server without the mint surface, or a transient minting error, must
  // not silently attribute the dispatched agent's writes to the person — unless
  // --allow-person-token (or dispatch.allowPersonToken) opts back into the old
  // fail-soft. Nothing has claimed a lease or launched anything yet, so a hard
  // fail here leaves no cleanup behind. Remote + a configured agent only;
  // local/unconfigured dispatch never reaches this block.
  let agentToken = null;
  let agentMcpFile = null;
  if (identityAgent) {
    // Always session-DEFERRED — the run session is bound after launch (below),
    // even when SPOR_SESSION_ID pins it (the pin feeds the capture, not the mint),
    // so the bind path is uniform.
    const mint = await mintAgentToken(cfg, { agent: identityAgent });
    if (mint.ok) {
      agentToken = mint.token;
      if (harnessAdapter.identityMode === "mcp-file") {
        agentMcpFile = writeDispatchMcpConfig(cfg, { token: mint.token, key: mcpKey });
      }
      out(`agent:  ${identityAgent} (writes attributed agent-on-behalf-of-you; run session bound after launch)`);
    } else if (!allowPersonToken) {
      // Name the offending agent and the fix — a bare "(HTTP 422 …)" tells the
      // operator nothing about WHICH id is wrong or how to repair it. The format
      // gate is caught client-side above, so a 422 here means the id is a
      // well-formed 'agent-<slug>' the server still rejected (e.g. no such agent /
      // not owned); point at the list either way
      // (issue-spor-dispatch-agent-id-prefix-validation-gap).
      err(
        `cannot dispatch ${nodeId || name}: could not mint an agent-scoped token for ${identityAgent}` +
          `${mint.absent ? " (this server can't mint agent-scoped session tokens yet)" : ` (${mint.error})`}.`
      );
      err(`  check it exists and you own it: spor agent list  (fix: spor agent use <agent-id>)`);
      err(`  pass --allow-person-token to dispatch person-scoped anyway (dispatch.allowPersonToken makes it standing).`);
      return 1;
    } else if (mint.absent) {
      err(`warning: this server can't mint agent-scoped session tokens yet — dispatching person-scoped (--allow-person-token).`);
    } else {
      err(`warning: could not mint an agent token for ${identityAgent} (${mint.error}) — dispatching person-scoped (--allow-person-token).`);
      err(`  check it exists and you own it: spor agent list  (set this machine's default with: spor agent use <agent-id>)`);
    }
  }

  // Establish the claim/lease BEFORE launching (task-spor-dispatch-auto-claim):
  // a node already claimed by someone else is caught here, so we never launch a
  // duplicate agent onto contested work, and the lease is live the moment the
  // agent starts (its post-tool writes then renew it — and seeing its own held
  // claim, it skips the redundant claim-nudge). Remote node-mode only; --no-claim
  // opts out (dispatch with no lease, the prior behavior). PERSON-SCOPED here
  // (session omitted, dec-spor-dispatch-bg-session-late-bind): the real session
  // isn't known until after launch in ANY launch mode (the supervised stream
  // announces it, `claude --bg` self-allocates it), so we bind it to the lease
  // via renewDispatch below; until then any of this person's sessions may renew it.
  let claimEstablished = false;
  if (nodeId && !backfill && !noClaim && cfg.mode() === "remote") {
    // Tag this claim with a per-invocation dispatch nonce so the server refuses a
    // SECOND concurrent dispatch of the same node — even by this same person, on
    // any machine (inc-spor-dispatch-duplicate-task-2026-06-18). --force opts out
    // (omit the nonce) so a deliberate re-dispatch renews instead of conflicting.
    const dispatchNonce = force ? null : crypto.randomUUID();
    const c = await claimDispatch(cfg, nodeId, null, dispatchNonce);
    if (c.conflict) {
      err(`${nodeId} is already claimed — ${c.message}`);
      err(`  not dispatching a duplicate. Re-run with --force to dispatch anyway (keeps the lease),`);
      err(`  --no-claim to dispatch with no lease, or pick another task with 'spor next'.`);
      return 1;
    }
    if (c.ok) {
      // Only mark this as a lease WE established: a --force claim omits the
      // nonce and RENEWS whatever lease already exists (per the conflict
      // message above, "keeps the lease") — that may be a live lease held by
      // an already-running agent from an earlier dispatch. Abort-cleanup below
      // must never release a lease this invocation didn't freshly create.
      claimEstablished = !!dispatchNonce;
      out(`claimed ${nodeId} (lease established; the agent's writes will renew it)`);
    } else err(`warning: could not establish a lease on ${nodeId}: ${c.error} — dispatching without a claim`);
  }
  // A worktree-creation/setup-hook failure, or a failure to even launch the
  // agent process, below aborts the dispatch without ever running an agent —
  // release the lease claimed just above so it doesn't strand the node
  // claimed-but-unattended (issue-spor-dispatch-worktree-setup-wrong-repo-
  // config: the failed attempt used to need a manual `spor release` before a
  // retry). Best-effort: a release failure here just leaves the existing
  // "needs a manual spor release" state, no worse than before.
  const releaseClaimOnAbort = async () => {
    if (!claimEstablished) return;
    const r = await remote.post(cfg, `/v1/nodes/${encodeURIComponent(nodeId)}/release`, {}, { timeoutMs: 6000 });
    if (r.ok) out(`  released the claim on ${nodeId}`);
    else err(`  warning: could not release the claim on ${nodeId} — retry with 'spor release ${nodeId}'`);
  };
  // Materialize the worktree just before launch — AFTER every guard/claim, so a
  // refused dispatch never leaves a worktree behind — and run the agent inside it.
  // res.dir stays the registered slug->path target (the durable main checkout,
  // issue-spor-dispatch-worktree-dir-stamping); only the launch cwd moves.
  let launchDir = res.dir;
  if (useWorktree) {
    const wt = createDispatchWorktree(res.dir, name, { slug: res.slug, nodeId });
    if (wt.error) {
      err(`could not create dispatch worktree under ${res.dir}: ${wt.error}`);
      err(`  (is ${res.dir} a git repo with at least one commit? or pass --no-worktree.)`);
      await releaseClaimOnAbort();
      return 1;
    }
    if (wt.setupError) {
      err(`dispatch worktree setup hook failed: ${wt.setupError}`);
      if (wt.created) {
        const rm = removeDispatchWorktree(res.dir, wt.dir, wt.branch);
        if (rm.removed) {
          err(`  removed the half-prepped worktree ${wt.dir}. Fix dispatch.worktreeSetup or pass --no-worktree.`);
        } else {
          err(`  could not remove the half-prepped worktree ${wt.dir}: ${rm.reason}`);
          err(`  clean it up manually, then fix dispatch.worktreeSetup or pass --no-worktree.`);
        }
      } else {
        err(`  left the reused worktree ${wt.dir} in place. Fix dispatch.worktreeSetup or pass --no-worktree.`);
      }
      await releaseClaimOnAbort();
      return 1;
    }
    launchDir = wt.dir;
    out(`worktree: ${wt.dir} (branch ${wt.branch}${wt.reused ? ", reused" : ""}${wt.setupRan ? "; setup ran" : ""})`);
  }

  if (harnessAdapter.launchMode === "supervised-jsonl") {
    const personToken = cfg.mode() === "remote" ? remote.token(cfg) : "";
    const mcpToken = agentToken || personToken;
    const wantsSporMcp = harnessAdapter.identityMode === "env-mcp" && cfg.mode() === "remote" && (
      !!identityAgent || (Array.isArray(profileRuntime.mcp) && profileRuntime.mcp.includes("spor"))
    );
    const args = harnessAdapter.buildArgs({
      name,
      model: effectiveModel,
      permissionMode: permMode,
      agent,
      // The `mcp-file` identity mechanism (Claude Code): the agent-scoped token
      // rides the 0600 --mcp-config written above, exactly as the native launch
      // carried it; an `env-mcp`/`env-token` adapter never has a file here.
      mcpConfig: agentMcpFile,
      sandbox: effectiveSandbox,
      approvalPolicy: effectiveApprovalPolicy,
      reportPath: dispatchHarnesses.REPORT_PLACEHOLDER,
      sporMcp: wantsSporMcp && mcpToken ? { url: `${remote.base(cfg)}/mcp` } : null,
      readOnly: readOnlyPosture,
    });
    const launched = await launchSupervisedHarness(cfg, {
      adapter: harnessAdapter,
      command: harnessBin,
      args,
      cwd: launchDir,
      readOnly: !!readOnlyPosture,
      name,
      nodeId,
      prompt,
      server: cfg.mode() === "remote" ? remote.base(cfg) : null,
      localNodesDir: cfg.mode() === "remote" ? null : cfg.nodesDir(),
      childToken: agentToken,
      mcpToken: wantsSporMcp ? mcpToken : null,
      bindToken: agentToken,
      renewToken: agentToken || personToken,
      renewNode: nodeId && !backfill && !noClaim ? nodeId : null,
      releaseNode: claimEstablished ? nodeId : null,
      project: res.slug || null,
    });
    if (!launched.ok) {
      err(`could not launch ${harnessBin}: ${launched.error}`);
      await releaseClaimOnAbort();
      return 1;
    }
    if (ctx && ctx.onLaunch) {
      ctx.onLaunch({
        run_id: launched.runId, harness: harnessAdapter.id, launch_mode: harnessAdapter.launchMode,
        node_id: nodeId || null, record_path: launched.paths.record,
      });
    }
    out(`run:     ${launched.runId} (${harnessAdapter.label} supervisor ${launched.state.state || "launching"})`);
    out(`log:     ${launched.paths.log}`);
    out(`report:  ${launched.paths.report}`);
    if (launched.state.session_id) out(`session: ${launched.state.session_id}`);
    return 0;
  }

  const nativeArgs = harnessAdapter.buildArgs({
    name,
    model: effectiveModel,
    permissionMode: permMode,
    agent,
    mcpConfig: agentMcpFile,
    prompt,
    readOnly: readOnlyPosture,
  });
  // A durable run record for the NATIVE-background launch (the `--bg` opt-in;
  // the supervised default writes its own record from the supervisor,
  // inc-spor-dispatch-session-vanished-2026-07-18). `claude --bg` hands the
  // child to its own daemon and returns, so this launcher never observes the
  // child's exit, and `claude agents --json` lists only LIVE agents — a run that
  // finished and a run that died look identical afterwards, which is precisely
  // how the 2026-07-18 Sonnet dispatches "vanished". Write the record at every
  // boundary we DO observe (launch, launcher exit, session bind); `spor runs`
  // classifies the terminal outcome later from the harness's own transcript.
  dispatchRuns.pruneRuns(cfg.userConfigHome(), { maxAgeMs: cfg.getNum("dispatch.runRetentionMs", 1209600000) });
  const nativeRun = dispatchRuns.beginNativeRun(cfg.userConfigHome(), {
    harness: harnessAdapter.id, name, nodeId, cwd: launchDir, model: effectiveModel || null,
  });
  // The agent's git must follow launchDir (its worktree, or the target checkout),
  // so hand it an env scrubbed of the git location vars — an ambient GIT_DIR
  // would otherwise point every commit it makes at the LAUNCHER's repo
  // (issue-spor-dispatch-worktree-wrong-repo-location). PWD gets the same
  // treatment as the supervised launch's cwd-agreeing env (opencodePrepareRun):
  // a spawn's `cwd` moves the child's real working directory but leaves the
  // INHERITED `PWD` pointing at the launcher's — pin it to launchDir so the two
  // launch modes agree instead of disagreeing about which env var is authoritative.
  const r = spawnPortableSync(harnessBin, nativeArgs, { cwd: launchDir, stdio: "inherit", env: { ...u.gitEnv(), PWD: launchDir } });
  if (r.error) {
    dispatchRuns.updateRun(nativeRun, {
      state: "failed_launch", termination_class: "launch", termination_signal: "launch-failed",
      termination_reason: r.error.message, error: r.error.message, finished_at: new Date().toISOString(),
      // A terminal record must always carry an outcome
      // (task-spor-dispatch-terminal-states-contract). Nothing here was checked
      // against the graph — no agent ever ran — so it is unenforced, and the
      // lease is handed back by releaseClaimOnAbort() below rather than by the
      // contract.
      ...dispatchRuns.unenforcedOutcome("failed_launch", "the harness process could not be started, so nothing was verified against the graph"),
    });
    err(`could not launch ${harnessBin}: ${r.error.message}`);
    await releaseClaimOnAbort();
    return 1;
  }
  const launcherOk = r.status === 0;
  dispatchRuns.updateRun(nativeRun, launcherOk
    ? { state: "running", launched_at: new Date().toISOString(), launcher_exit: 0 }
    : {
        state: "failed_launch", launcher_exit: r.status == null ? null : r.status,
        termination_class: "launch", termination_signal: "launcher-nonzero",
        termination_reason: `${harnessBin} exited ${r.status == null ? "abnormally" : r.status} without leaving a background agent`,
        finished_at: new Date().toISOString(),
        ...dispatchRuns.unenforcedOutcome("failed_launch", "the harness left no background agent, so nothing was verified against the graph"),
      });
  if (ctx && ctx.onLaunch && launcherOk) {
    ctx.onLaunch({
      run_id: nativeRun.runId, harness: harnessAdapter.id, launch_mode: harnessAdapter.launchMode,
      node_id: nodeId || null, record_path: nativeRun.paths.record,
    });
  }
  out(`run:     ${nativeRun.runId} (${harnessAdapter.label}; 'spor runs' for its outcome)`);
  if (!launcherOk) {
    // A non-zero exit here means the harness never left a background agent
    // behind — the same "no agent will ever attend this node" case the
    // spawn-error branch above already aborts on, so it needs the same
    // releaseClaimOnAbort() so the claim doesn't strand the node.
    err(`${harnessBin} exited ${r.status == null ? "abnormally" : r.status} without leaving a background agent`);
    await releaseClaimOnAbort();
    return r.status == null ? 1 : r.status;
  }

  // Late session binding for the NATIVE-background `--bg` opt-in
  // (dec-spor-dispatch-bg-session-late-bind; a supervised run binds its session
  // from its own stream in the supervisor instead). `claude --bg`
  // has now self-allocated its run session and registered the agent; read the
  // REAL session from `claude agents --json` and bind it: (a) rebind the agent
  // token's session so every subsequent agent write stamps the real run, and
  // (b) renew the lease to it so lease and token agree (instead of waiting for
  // the agent's first heartbeat to self-heal). Best-effort throughout — a capture
  // miss or any bind failure leaves the token session-null (writes carry no
  // session: honest, never a phantom) and the lease self-healing via heartbeat.
  // Remote only, and only when there's something to bind (an agent token and/or a
  // claimed node).
  //
  // The capture itself now runs in BOTH modes, because the session id is the
  // only thing that ties a run to its own transcript: a project dir is one
  // CHECKOUT, and every `--no-worktree` dispatch into the same repo shares it,
  // so without this a run can only be identified by co-location — which is how
  // a live sibling agent held a dead run open and donated it a transcript
  // (issue-spor-dispatch-run-liveness-same-cwd-misattribution). Only the
  // remote-side binding below stays remote-only. Best-effort: a capture miss
  // leaves the record honestly session-less rather than guessing.
  const realSession = await captureDispatchSession(cfg, name, launchDir, pinnedSession, Date.parse(nativeRun.record.created_at) || 0);
  // Record the session whether or not the remote bind succeeds: it is the
  // pointer `spor runs` follows to the harness transcript that holds this
  // run's terminal reason.
  if (realSession) dispatchRuns.updateRun(nativeRun, { session_id: realSession, bound_at: new Date().toISOString() });
  const wantBind = cfg.mode() === "remote" && (agentToken || (nodeId && !backfill && !noClaim));
  if (wantBind) {
    if (realSession) {
      if (agentToken) {
        const b = await bindAgentSession(cfg, agentToken, realSession);
        if (b.ok) out(`session: ${realSession} (bound — the agent's writes trace to this run)`);
        else if (b.conflict) err(`note: the agent token is already bound to another session — leaving it.`);
        // absent/transport error: token stays session-deferred (no phantom) — silent, fail-open.
      } else {
        out(`session: ${realSession}`);
      }
      if (nodeId && !backfill && !noClaim) await renewDispatch(cfg, nodeId, realSession);
    } else if (agentToken) {
      err(`note: could not read the run session from 'claude agents' — writes will carry no session stamp (the lease still self-heals).`);
    }
  }
  return r.status == null ? 1 : r.status;
}

// --- spor work: the pull-based continuous worker loop (task-spor-work-loop) --
// One command turns this box into a factory worker over the queue: poll, pick
// what this machine may run, dispatch under the routed profile, wait for the
// TERMINAL state, repeat. The loop itself lives in lib/shell/work-loop.js (a
// dependency-injected machine, so it is testable without launching anything);
// everything here is the wiring — how a candidate page, a dispatch, and a run
// record are obtained on a real box.
//
// It is a GENERALIZATION of `spor dispatch --from-queue`, not a second
// dispatcher: selection is dispatchableQueuePage (the same filtered page
// --from-queue picks its one item from) and every launch goes through
// cmdDispatch, so all its guards — already-resolved, requires:human,
// satisfiability's no-substitution refusal, the graph-declared-launch-field
// refusal, the same-machine and nonce duplicate guards, the auto-claim, the
// worktree isolation, the supervisor, the run record, the terminal-state
// contract — apply unchanged and can never drift from the one-shot path.

// The `alive(pid, ticks)` predicate workLoop.runHarvest uses to decide
// whether a `contract_pending` run's supervisor is still trusted to close it
// (the bounded hold in runHarvest's contract-pending branch) — routed through
// the shared, EPERM-tolerant isSameSupervisor rather than a bare pidAlive, the
// same divergence class already unified for terminalOutcomeBackfill and
// finalizeSupervisedRun (issue-spor-dispatch-supervisor-liveness-check-
// divergence). Extracted to a named export so the EPERM/identity-unknown
// behavior is pinned directly rather than only indirectly, through a live
// dispatch.
function runSupervisorAlive(pid, ticks) {
  return dispatchRuns.isSameSupervisor(pid, ticks).reallyAlive;
}

// Ask the graph the ONE question WORKERS.md §6 asks — does this run's target
// read RESOLVED? — outside the supervised run that normally asks it
// (task-spor-work-idle-run-detection). Two callers below need it, and both are
// the same situation: the process that would have run the contract is not going
// to. Returns the verified `resolved` patch, or null for "not resolved, or
// could not tell" — the fail-safe direction, since only a POSITIVE reading is
// ever allowed to overwrite what a record already says.
//
// The door is this worker's own config (same box, same tenant), except the
// LOCAL graph home, which is read back from the run's own job file: the
// launcher resolved that home for this run and a repo `graph:` binding can make
// it differ from the worker's cwd-resolved one.
async function verifyRunResolution(cfg, record) {
  const nodeId = record && record.node_id;
  if (!nodeId) return null;
  if (remote.isRemote(cfg)) {
    let res = null;
    try {
      res = await remote.get(cfg, `/v1/nodes/${encodeURIComponent(nodeId)}`);
    } catch {
      return null; // an unreachable graph is not evidence of anything
    }
    if (!res || !res.ok) return null;
    return dispatchTerminal.resolvedOutcomeFromNode(res.json || {});
  }
  let job = null;
  try {
    job = JSON.parse(fs.readFileSync(dispatchRuns.runPaths(cfg.userConfigHome(), record.run_id).job, "utf8"));
  } catch { /* the job file has been pruned, or predates local_nodes_dir */ }
  return dispatchTerminal.verifyLocalResolution((job && job.local_nodes_dir) || cfg.nodesDir(), nodeId);
}

// Which of this worker's runs are over, and what they did to the graph.
// RECONCILE first, exactly as `spor runs` does. Every run this loop dispatches
// is SUPERVISED (cmdDispatch's `supervisedOnly`), and a supervised run's
// supervisor closes its own record, so following them needs no harness
// listing at all. Only a native-background record — one a RESUMED pipeline
// adopted from before the supervised default (§10.8), never a run this loop
// launched — has an ending invisible to its launcher, resolvable only against
// the harness's live-agent list plus its own transcript; the listing is taken
// only when such a record is among the runs asked about (nativeAgentEvidence),
// so a worker following its own runs never boots a harness CLI per poll.
async function pollWorkRuns(cfg, runIds, { maxAgeMs = 0, idleMs = 0, warn = () => {} } = {}) {
  const home = cfg.userConfigHome();
  const wanted = new Set(runIds || []);
  if (!wanted.size) return [];
  const { agents, enumerated } = nativeAgentEvidence(
    cfg,
    dispatchRuns.readRunRecords(home).filter((r) => r && wanted.has(r.run_id))
  );
  const records = dispatchRuns.reconcileRuns(home, { agents, enumerated });
  const found = new Map();
  for (const r of records) if (r && wanted.has(r.run_id)) found.set(r.run_id, r);
  // Answer for EVERY id asked about, including one the store no longer holds:
  // a slot whose run record has vanished can never be observed going terminal,
  // so reporting nothing for it would hold that slot for the life of the
  // worker. workLoop.runHarvest owns the rule; this only names what it decided.
  const out = [];
  for (const id of wanted) {
    let record = found.get(id) || null;
    const verdict = workLoop.runHarvest(record, {
      terminalStates: dispatchRuns.TERMINAL_STATES,
      alive: runSupervisorAlive,
      maxAgeMs,
      idleMs,
      // OBSERVED activity, never the launch fallback: a record with no output
      // channel this box can read (an unbound native-background run) must fall
      // through to the watchdog rather than read as silent since launch.
      activityAt: (r) => dispatchRuns.observedActivityAt(r),
    });
    if (verdict.why === "missing") {
      out.push({
        run_id: id, terminal: true,
        record: { run_id: id, state: "missing", terminal_note: "the run record is gone — this worker can no longer follow the run ('spor runs' aged it out, or it was removed)" },
      });
      continue;
    }
    if (verdict.why === "idle") {
      // The one verdict that ACTS on the run rather than just stopping to
      // follow it: the run has written nothing for longer than any real step
      // takes, so it is wedged, and leaving it alone would pin this slot (and
      // its lease, and its worktree) until the 24h watchdog. Verify the graph
      // BEFORE classifying — an agent that wrote its resolver and then hung
      // did the work, and `resolved` is a graph read, never an exit code.
      const quietAt = dispatchRuns.observedActivityAt(record);
      const outcome = await verifyRunResolution(cfg, record);
      const { record: closed, stopped } = await dispatchRuns.stopIdleRun(home, record, { idleMs, quietAt, outcome });
      // ENDED, not merely signalled: the record is now terminal and nothing
      // reconciles it again, so "we sent SIGTERM" is not enough to believe the
      // checkout is free.
      const ended = (stopped.child || stopped.supervisor || stopped.group) && !stopped.alive;
      warn(
        `work: ${ended ? "stopping" : "giving up following"} run ${String(id).slice(0, 8)} (${record.node_id || record.name || "?"}) — nothing written to its log or transcript for ` +
          `${Math.max(1, Math.round((verdict.quietMs || 0) / 60000))}m (idle ceiling ${Math.max(1, Math.round(idleMs / 60000))}m)` +
          `${ended ? "" : `; ${stopped.alive ? "it did not die on SIGTERM/SIGKILL" : "it had no process of ours to signal"}, so something may still be running in its checkout`}` +
          `${outcome ? ". Its target reads resolved on the graph" : ""}.`
      );
      out.push({
        run_id: id, terminal: true,
        // Having ENDED the run, the ordinary refusal window is the honest
        // cooldown (and a resolved target is never cooled at all). Otherwise we
        // only stopped FOLLOWING it, which is the watchdog's situation exactly
        // and takes the watchdog's rule: cool the node for at least as long as
        // the silence we waited out, rather than re-dispatching into a checkout
        // something may still hold.
        ...(ended ? {} : { cool_ms: idleMs }),
        record: closed,
      });
      continue;
    }
    if (verdict.why === "state" && record && record.contract_pending && record.terminal_state !== "resolved") {
      // The contract's grace has expired (or its supervisor is gone) and the
      // record still carries the PROVISIONAL, unenforced placeholder. Filing
      // that as the verdict is how a genuinely resolved run gets recorded as
      // an unenforced `reported`, gated, and cooled off despite being done, so
      // run the verify leg the supervisor did not reach. Only a positive
      // reading is written: "we could not tell" leaves the record exactly as
      // it was, still flagged pending for a slow supervisor to settle.
      const outcome = await verifyRunResolution(cfg, record);
      if (outcome) {
        record = dispatchRuns.settleContractOutcome(home, record, {
          ...outcome,
          terminal_note: `${outcome.terminal_note} — verified by this worker after the supervisor did not settle the terminal-state contract in time`,
        });
      }
    }
    if (verdict.why === "watchdog") {
      // The record is still non-terminal, so `spor runs` keeps reconciling it;
      // this worker simply stops holding a slot for it, and says so.
      warn(`work: giving up following run ${String(id).slice(0, 8)} (${record.node_id || record.name || "?"}) — it has not reached a terminal state in ${Math.round(maxAgeMs / 3600000)}h ('spor runs' still tracks it).`);
      out.push({
        run_id: id, terminal: true,
        // Giving up on FOLLOWING a run says nothing about whether it stopped,
        // so the node is cooled for at least as long as we followed it rather
        // than for the ordinary refusal window.
        cool_ms: maxAgeMs,
        record: { ...record, terminal_note: `this worker stopped following the run after ${Math.round(maxAgeMs / 3600000)}h without a terminal state` },
      });
      continue;
    }
    if (!enumerated && record && record.launch_mode === "native-background" && !verdict.terminal) {
      // The same caveat `spor runs` prints, reachable here only for a native
      // record a resumed pipeline adopted (this loop launches none): a native
      // run's state can only be resolved against the harness's live-agent
      // listing, and this call could not read one. The slot is held (correctly
      // — nothing says the run is over, and the idle ceiling / watchdog bound
      // the hold), but a worker that quietly stops dispatching must say why.
      warn(
        "work: could not list live background agents — a native run's state may be stale, so its slot stays held ('spor runs' reports the same)" +
          // Only where the run bound a session: the idle ceiling reads a native
          // run's freshness off its transcript, and an unbound record has none.
          `${idleMs > 0 && record.session_id ? `; the idle ceiling still frees it after ${Math.max(1, Math.round(idleMs / 60000))}m of silence` : ""}.`
      );
    }
    out.push({ run_id: id, terminal: verdict.terminal, record });
  }
  return out;
}

// Dispatch ONE queue item through the real `spor dispatch` code path, and
// report back what the exit code cannot: the run this started, or the reason
// it was refused. The refusal reason is the refusal's own first stderr line,
// captured via ERR_TEE — a guard that already explains itself to the operator
// should not have to explain itself twice.
//
// Auto-route by `profile:` frontmatter (task-spor-test-change-lane-auto-
// routing): the gate pipeline's test-change lane item names the lane profile
// this way (§10.3, buildGateWorkNode), and until now nothing read it — only an
// operator running `spor work --profile <lane>` (or `spor dispatch --profile`)
// by hand ever picked it up. `dispatchableQueuePage` surfaces that field
// verbatim (rankQueue), so an item carrying it is routed exactly as if
// `--profile <that>` had been passed for THIS dispatch — unless the worker's
// own `--profile` (the loop's `passthrough`, sourced from the CLI flag only —
// there is no `work.profile` config-cascade key) already pins one, which
// wins (the same explicit-beats-inferred precedence `resolveDispatchProfile`
// applies to the node's `assigned -> agent` edge). A box that cannot satisfy
// the routed profile refuses the dispatch loudly, same as an explicit
// `--profile` would — the item cools off and stays for a worker that can.
//
// The WORKER CONTRACT rides along as the task text (the prompt's third part,
// WORKERS.md §4): commit before you resolve, never merge to the target ref,
// leave the protected suite alone, resolve last (lib/shell/worker-contract.js).
// `spor dispatch` on its own stays byte-identical — a person aiming one agent
// at one node writes their own instructions; an unattended loop cannot.
async function dispatchWorkItem(cfg, item, passthrough, { factory = null } = {}) {
  const values = { ...passthrough, node: item.id };
  if (!values.profile && item.profile) values.profile = item.profile;
  return dispatchThrough(cfg, values, [workerContract({ nodeId: item.id, factory })]);
}

// Whether THIS machine can satisfy a loaded factory's integration
// requirements (task-spor-propose-gh-capability-satisfiability) — today just
// `gh` for `mode: propose`, checked through the machine-profile
// satisfiability layer (dec-spor-machine-profile-satisfiability) rather than
// a bespoke probe. Re-probed fresh on every call (mirrors
// resolveDispatchProfile) so the verdict reflects current reality — gh
// installed mid-session, or a fresh box with no prior session-start probe —
// rather than a stale snapshot. Trivially satisfiable for any factory that
// isn't propose mode (the common case), including no factory at all.
function integrationSatisfiability(cfg, factory) {
  // Skip the probe entirely for the common case (no factory, or a factory
  // whose integration isn't propose mode) — a full probe re-reads the
  // claude-plugins manifest and re-scans PATH, not worth paying on every
  // dispatch attempt of an unrelated factory.
  if (!factory || !factory.integration || factory.integration.mode !== "propose") return { ok: true, reasons: [] };
  const rawCap = cfg.get("dispatch.capabilities", {}) || {};
  let probed = null;
  try {
    probed = u.probeCapabilities(cfg.userConfigHome(), { sporReachable: cfg.mode() === "remote", cfg });
  } catch {
    /* probe is best-effort; match against what the cascade already holds */
  }
  const machine = sat.effectiveCapabilities(probed ? { ...rawCap, probed } : rawCap);
  return sat.satisfiesIntegration(machine, factory);
}

// The shared body of the above and of the gate pipeline's review/fix launches
// (task-spor-work-gate-pipeline): one dispatch through the real code path,
// reporting the run it started or the refusal's own reason.
//
// SERIALIZED, because the refusal-reason capture is a GLOBAL sink (ERR_TEE):
// a gate pipeline runs as a detached promise beside the loop, so without this
// its review/fix launch could swap the sink mid-flight and file another
// dispatch's refusal under the wrong item. The lock is held only until a
// launch returns (seconds), never for the life of a run.
let DISPATCH_LOCK = Promise.resolve();
function dispatchThrough(cfg, values, positionals = []) {
  const run = DISPATCH_LOCK.then(() => dispatchThroughLocked(cfg, values, positionals));
  DISPATCH_LOCK = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function dispatchThroughLocked(cfg, values, positionals = []) {
  const launches = [];
  const lines = [];
  const previousTee = ERR_TEE;
  ERR_TEE = lines;
  let code;
  try {
    // supervisedOnly: a worker's runs must be followable and judgeable, so
    // neither `--bg` nor a standing dispatch.claudeLaunchMode may route them
    // native-background (see cmdDispatch's launch-mode opt-in).
    // carryTask: whatever prompt template rides the passthrough (or a personal
    // dispatch.template), the task text — the worker contract, a fix cycle's
    // or a rescue's instructions, the one-turn notice — reaches the agent.
    code = await cmdDispatch(cfg, { values, positionals }, { onLaunch: (l) => launches.push(l), supervisedOnly: true, carryTask: true });
  } catch (e) {
    // A throw AFTER the launch (the post-launch session capture and bind are
    // network calls) still means an agent is running and holding a lease —
    // report the run rather than recording a skip for work that is under way.
    if (launches.length) return { ok: true, run: launches[0] };
    return { ok: false, reason: `dispatch failed: ${e && e.message ? e.message : String(e)}` };
  } finally {
    ERR_TEE = previousTee;
  }
  if (code === 0 && launches.length) return { ok: true, run: launches[0] };
  // Exit 0 with no launch is the one shape that is neither: --print, or a
  // harness this client launched but cannot follow. Treat it as a skip — a
  // slot held for a run we can never see end would never be freed.
  return {
    ok: false,
    reason: workLoop.refusalReason(
      lines,
      code === 0 ? "dispatch started nothing this worker can follow" : `dispatch exited ${code}`
    ),
  };
}

// The status surface (`spor work --status`), the read-back half the factory-
// builder skill needs: what every worker on this box is doing, has done, and
// is deliberately not doing. Reads the machine-local records only — never the
// graph, never the network.
// A worker process is only THIS worker if the pid is alive AND was started at
// the same moment — the run store's pid-reuse guard, applied to worker
// records. Routed through the shared, EPERM-tolerant isSameSupervisor rather
// than bare pidAlive() plus a hand-rolled ticks comparison — the same
// divergence class already unified for activeRuns/runHarvest
// (issue-spor-dispatch-supervisor-liveness-check-divergence): a worker pid
// owned by another UID (root-recycled) used to misreport as stale here, and
// the identity fallback for a ticks-less record ("no stamp: the pid probe is
// all there is") is exactly `isSameSupervisor`'s own identityKnown=false
// behavior, so no separate ticks branch is needed.
function workerAlive(pid, ticks) {
  return dispatchRuns.isSameSupervisor(pid, ticks).reallyAlive;
}

function cmdWorkStatus(cfg, { json }) {
  const home = cfg.userConfigHome();
  const workers = workLoop.readWorkerStatuses(home, { alive: workerAlive });
  if (json) {
    out(JSON.stringify({ count: workers.length, workers }, null, 2));
    return 0;
  }
  if (!workers.length) {
    out("no spor work loops recorded on this machine.");
    return 0;
  }
  for (const w of workers) {
    const state = w.stopped_at ? `stopped (${w.stop_reason || "?"})` : w.stale ? `stale — pid ${w.pid} is gone` : w.state || "running";
    const o = w.outcomes || {};
    out(
      `${String(w.worker_id).slice(0, 8)}  ${state}  ${w.project || "(all projects)"}  ` +
        `${w.accept ? `accept ${w.accept}  ` : ""}` +
        `${(w.active || []).length}/${w.concurrency} slots  dispatched ${w.dispatched || 0}  ` +
        `resolved ${o.resolved || 0} reported ${o.reported || 0} failed ${o.failed || 0}${o.declined ? ` declined ${o.declined}` : ""}` +
        `${o.unenforced ? ` (${o.unenforced} unenforced)` : ""}`
    );
    if (w.gates)
      out(
        `  gates:    ${w.factory || "(factory)"}${(w.repos || []).length ? ` [judges ${w.repos.join(", ")}]` : ""} — passed ${w.gates.passed || 0}, failed ${
          w.gates.failed || 0
        }, blocked ${w.gates.blocked || 0}${w.gates.parked ? `, parked ${w.gates.parked}` : ""}${w.gates.superseded ? `, superseded ${w.gates.superseded}` : ""}`
      );
    for (const a of w.active || []) out(`  active:   ${a.node_id || "(free-text)"}  run ${String(a.run_id).slice(0, 8)}  ${a.harness || ""}  since ${a.started_at}`);
    for (const g of w.gating || []) {
      out(`  gating:   ${g.node_id}  run ${String(g.run_id).slice(0, 8)}  since ${g.started_at}`);
      // A fix cycle a stopped worker's pipeline left running is a durable
      // fact on the RUN RECORD (gate_fix_run_id, stamped the moment the fix
      // was dispatched — see makeGateDeps' `fix`), not on this status file, so
      // read it back here: an operator staring at a stale/stopped worker's
      // `gating` slot needs the child run's id, not just the parent's.
      let gateRecord = null;
      try {
        gateRecord = dispatchRuns.readJson(dispatchRuns.runPaths(home, g.run_id).record);
      } catch {
        /* the gating line above still stands without it */
      }
      if (gateRecord && gateRecord.gate_fix_run_id) {
        out(`            fix cycle in flight: run ${String(gateRecord.gate_fix_run_id).slice(0, 8)} — 'spor runs ${gateRecord.gate_fix_run_id}' follows it`);
      }
    }
    for (const r of (w.recent || []).slice(0, 5)) {
      out(
        `  done:     ${r.node_id || "(free-text)"}  ${r.terminal_state || r.state || "?"}` +
          `${r.terminal_state && !r.terminal_enforced ? " (unenforced)" : ""}` +
          `${r.resolved_by ? ` by ${r.resolved_by}` : ""}${r.report_node_id ? ` — report ${r.report_node_id}` : ""}` +
          `${r.gate ? `  gates ${r.gate}` : ""}`
      );
      if (r.gate && r.gate !== "passed" && r.gate_reason) out(`            ${r.gate_reason}`);
      // The fail-soft half of a refusal: the verdict stands either way, but an
      // operator has to know the item is still reading DONE on the graph.
      if (r.demote_reason) out(`            not demoted on the graph: ${r.demote_reason}`);
      // ...and its atomic twin: the escalation never landed, so NOTHING was
      // written to the graph — no blocker, and deliberately no rollback either
      // (task-spor-gate-escalation-demote-atomic). This refusal exists only
      // here until someone re-runs the judgement, so it has to be said out
      // loud rather than left in a `gate_reason` a 300-char slice can cut off.
      if (r.escalation_failed) {
        out(`            no escalation could be filed, so nothing was demoted — re-judge with 'spor work --regate ${r.run_id}'`);
      }
    }
    // One pass can cool off a whole page of items (a queue of untriaged work
    // under the default accept policy, a sibling repo's items under a scoped
    // factory), so listing the first five and stopping told an operator that
    // five were skipped. The list stays capped — a status read is a glance, and
    // --json carries every entry — but the REST is counted, by reason.
    const skips = w.skipped || [];
    const shown = workLoop.SKIP_LOG_CAP;
    for (const s of skips.slice(0, shown)) out(`  skipped:  ${s.id} — ${s.reason} (retry after ${s.until})`);
    if (skips.length > shown) {
      out(`  skipped:  +${skips.length - shown} more — ${workLoop.summarizeSkips(skips.slice(shown).map((s) => s.reason))} ('spor work --status --json' lists them all)`);
    }
    if (w.next_poll_at && !w.stopped_at) out(`  next poll: ${w.next_poll_at}`);
  }
  return 0;
}

// --- the gate pipeline wiring (task-spor-work-gate-pipeline) ---------------
// The factory definition is graph DATA (kernel/gates.js parses it); the gates
// are enforced here, in code, between the claim and the resolve. Everything
// below is the shell half — git plumbing, dispatch, graph writes — handed to
// lib/shell/gate-runner.js as injected deps so the pipeline itself stays
// drivable with fakes.

// Read a `type: factory` node and every shareable `type: gate` node it
// references, and fold them into one validated definition. Errors are FATAL to
// the worker (cmdWork refuses to start): an operator who declared gates and
// mistyped them must not get a silently ungated worker — that is the one
// failure mode enforcement-in-code exists to remove.
async function loadFactoryDefinition(cfg, id) {
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  const parse = (raw, file) => {
    try {
      return graphLib.parseFrontmatter(raw, file);
    } catch {
      return {};
    }
  };
  const node = await resolveNode(cfg, id);
  if (!node || !node.raw) {
    return { factory: null, errors: [`factory definition '${id}' could not be read from the graph`] };
  }
  const parsed = parse(node.raw, `${id}.md`);
  if ((parsed.type || "") !== "factory") {
    return {
      factory: null,
      errors: [
        `'${id}' is a '${parsed.type || "?"}' node, not a 'type: factory' definition` +
          ` (the factory schema ships as a candidate — 'spor schema adopt schema-factory')`,
      ],
    };
  }
  // status defaults to active (GRAPH.md "Correction nodes" lifecycle
  // convention); anything else (retired, proposed, ...) must not enforce.
  if (parsed.status && parsed.status !== "active") {
    return {
      factory: null,
      errors: [`'${id}' is '${parsed.status}', not 'status: active' — a retired or proposed factory never enforces`],
    };
  }
  const errors = [];
  const gateNodes = new Map();
  const explainedRefs = new Set(); // refs whose problem we already reported below
  for (const ref of gatesKernel.factoryRefs(parsed.body || "")) {
    const gn = await resolveNode(cfg, ref);
    if (!gn || !gn.raw) continue; // resolveGates reports the missing reference itself
    const pg = parse(gn.raw, `${ref}.md`);
    if ((pg.type || "") !== "gate") {
      errors.push(`referenced gate '${ref}' is a '${pg.type || "?"}' node, not a 'type: gate' node`);
      explainedRefs.add(ref);
      continue;
    }
    if (pg.status && pg.status !== "active") {
      errors.push(`referenced gate '${ref}' is '${pg.status}', not 'status: active' — a retired or proposed gate never enforces`);
      explainedRefs.add(ref);
      continue;
    }
    const payload = gatesKernel.fencedJson(pg.body || "");
    if (!payload.ok) {
      errors.push(`referenced gate '${ref}': ${payload.error}`);
      explainedRefs.add(ref);
      continue;
    }
    gateNodes.set(ref, payload.payload);
  }
  // The node's own project stamp is the factory's DEFAULT repo scope when its
  // payload declares no `repos` (issue-spor-work-scope-union-factory-mismatch)
  // — a factory authored for one repo says so by living in it.
  const res = gatesKernel.parseFactory(parsed.body || "", { gateNodes, id, project: parsed.project || null });
  // A ref we already explained above (wrong type, retired, bad payload) is left
  // out of gateNodes on purpose, which makes resolveGates raise its own generic
  // "could not be read from the graph" for the same ref — accurate for an
  // actually-missing node, but misleading here. Drop that duplicate rather than
  // relying on it: the null-factory decision is ours (errors.length), not a
  // side effect of resolveGates independently agreeing.
  const resErrors = res.errors.filter(
    (e) => ![...explainedRefs].some((ref) => e.includes(`referenced gate '${ref}' could not be read from the graph`))
  );
  // There is deliberately NO launch-mode precheck on the agent-review / rescue
  // profiles here any more (task-spor-work-honor-claude-launch-mode-and-
  // retire-native-precheck). One used to refuse a profile whose harness
  // launched native-background (`claude --bg`, no report channel to read a
  // verdict off); since task-spor-claude-adapter-headless-supervised every
  // built-in launches SUPERVISED by default, a declared harness is supervised
  // by v1 scope, and a worker's dispatches pass `supervisedOnly` (so neither
  // `--bg` nor dispatch.claudeLaunchMode can route them native), so nothing
  // could ever trip it. What it guarded against is still fail-closed at run
  // time: a review or rescue that leaves no report is a gate FAILURE
  // (gateRunReportText's own error), never a pass.
  return { factory: errors.length ? null : res.factory, errors: [...new Set([...errors, ...resErrors])] };
}

// The git plumbing for a command gate — reading the change under judgement,
// materializing the trusted-ref tree, running the suite — lives in
// lib/shell/gate-runner.js beside the pipeline it serves (and is unit-tested
// against a real temp repo there).
const { gateChangeSet, prepareGateTree, runGateCommand } = gateRunner;

// Follow a gate's own dispatched run (a review, a fix cycle) to its terminal
// state. Bounded — a review that never ends must fail its gate rather than hold
// the worker's slot for the life of the process.
async function awaitGateRun(cfg, runId, { timeoutMs, pollMs = 5000, warn = () => {}, sleep, now = () => Date.now() }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    let verdict = null;
    try {
      verdict = (await pollWorkRuns(cfg, [runId], { maxAgeMs: 0, warn }))[0];
    } catch (e) {
      return { ok: false, reason: `the run record could not be read: ${e.message}` };
    }
    if (verdict && verdict.terminal) return { ok: true, record: verdict.record };
    const at = now();
    if (at >= deadline) {
      return { ok: false, reason: `the run did not reach a terminal state within ${Math.round(timeoutMs / 60000)}m ('spor runs' still follows it)`, record: verdict && verdict.record };
    }
    await sleep(Math.min(pollMs, Math.max(1000, deadline - at)));
  }
}

// A dispatched run's own final report text — the channel a review gate's
// structured verdict comes back on. Supervised launches write it; a native
// background launch does not, which is why an agent-review gate must be routed
// to a supervised profile (the gate says so when the text is missing).
function gateRunReportText(record) {
  const file = record && record.report_path;
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// A rescue's diagnosis (WORKERS.md §10.10): the final report first, then —
// when that carries no block — the LAST block in any EARLIER message on the
// run's own stream, newest first. The supervisor keeps the last assistant
// text as the report (the `--output-last-message` semantics every harness
// shares), so a rescue that emitted its block early, as it is told to, and
// then ended on "I'll commit once the suite notifies me" has the block only
// on the log; reading just the report would file that session as
// category "unknown" — the truncation case the early block exists for
// (issue-spor-rescue-and-fix-sessions-end-turn-waiting-on-background-job).
// Between the two sits the rescue's DIAGNOSIS FILE — the channel that does
// not depend on the harness at all. The stream read can only ever cover a
// harness whose events carry a text path the client knows (a built-in
// adapter's hook, a declared `report: lastText`); a declared harness that
// writes its own report file (`report: file`) describes NO message shape, so
// its stream is unreadable by construction and the salvage reads [] — the
// row the stream fix could never close. So the rescue is also told to write
// the same block to a named file in its own checkout (`rescueDiagnosisPath`:
// `.spor-rescue/<run name>.json`, git-excluded and untracked, so the gates —
// which judge tracked, committed work — never see it) the moment it has
// diagnosed, and the read consults that file before the stream: a harness
// that can run an implementer can write a file into its workspace, whatever
// its sandbox or its stream looks like. `salvaged` says where a diagnosis
// that was not in the final report came from: "file" or "stream".
function gateRescueDiagnosis(record, home, { file = null } = {}) {
  const parsed = gatesKernel.parseRescueReport(gateRunReportText(record));
  if (parsed.ok) return parsed;
  if (file) {
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      raw = "";
    }
    if (raw.trim()) {
      const p = gatesKernel.parseRescueReport(raw);
      if (p.ok) return { ...p, salvaged: "file" };
    }
  }
  const earlier = dispatchRuns.runReportTexts(record, { home });
  for (let i = earlier.length - 1; i >= 0; i--) {
    const p = gatesKernel.parseRescueReport(earlier[i]);
    if (p.ok) return { ...p, salvaged: "stream" };
  }
  return parsed;
}

// Where a rescue run writes its diagnosis file: inside the checkout it works
// in (the one place every harness sandbox lets an implementer write), under a
// directory of its own, keyed by the run's unique name so a resumed pipeline
// adopting the run by name finds the same file.
const RESCUE_DIAGNOSIS_DIR = ".spor-rescue";
function rescueDiagnosisPath(cwd, name) {
  return path.join(cwd, RESCUE_DIAGNOSIS_DIR, `${name}.json`);
}

// Keep that directory out of git for the checkout: an entry in the repo's
// own `info/exclude` (never the tracked .gitignore — that would be a change
// under review), so a rescue that stages with `git add -A` cannot commit its
// diagnosis into the branch the gates judge. Idempotent, fail-soft: a
// checkout that is not a git repo, or an exclude file that cannot be
// written, leaves the gates' own untracked-residue tolerance as the backstop.
function excludeRescueDiagnosisDir(cwd) {
  try {
    const r = spawnSync("git", ["-C", cwd, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    if (r.status !== 0) return false;
    const rel = String(r.stdout || "").trim();
    if (!rel) return false;
    const exclude = path.resolve(cwd, rel);
    const entry = `/${RESCUE_DIAGNOSIS_DIR}/`;
    let cur = "";
    try {
      cur = fs.readFileSync(exclude, "utf8");
    } catch {
      cur = "";
    }
    if (cur.split(/\r?\n/).some((l) => l.trim() === entry)) return true;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${cur && !cur.endsWith("\n") ? "\n" : ""}${entry}\n`);
    return true;
  } catch {
    return false;
  }
}

// Gate nodes mint `date:` from `new Date()` at write time (WORKERS.md §10.7),
// so the SAME outcome re-filed for the SAME run across a date boundary (a
// resumed pipeline, a re-gated dispatch) carries a different `date:` line
// even though nothing about the fact changed. The idempotency compare below
// must not treat that as a content collision — so it normalizes the
// frontmatter `date:` line away before comparing, leaving every other field
// (including a genuinely different verdict/summary) fully significant.
function stripFrontmatterDate(markdown) {
  const text = String(markdown || "");
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return text;
  return text.slice(0, end).replace(/^date: .*$/m, "date:") + text.slice(end);
}

// Write a gate's node — a fact, an escalation, an approval — through the same
// validated door `spor put-node` uses, idempotently (a deterministic id written
// twice is one node, never two).
async function writeGateNode(cfg, id, markdown) {
  if (cfg.mode() === "remote") {
    const r = await remote.post(cfg, "/v1/nodes", { nodes: [{ node: markdown, if_exists: "skip" }] }, { timeoutMs: 15000 });
    if (r.transport) return { ok: false, reason: `offline — ${r.error}` };
    const res0 = r.json && r.json.results && r.json.results[0];
    if (res0 && (res0.ok === true || res0.status === "skipped" || res0.status === "created")) return { ok: true, id };
    return { ok: false, reason: putNodeEntryError(res0, r.status, "gate") };
  }
  const dir = cfg.nodesDir();
  try {
    if (!fs.existsSync(dir)) return { ok: false, reason: `no graph at ${dir} — run 'spor init' first` };
    const file = path.join(dir, `${id}.md`);
    if (fs.existsSync(file)) {
      // if_exists: skip, with the ONE distinction the remote door also draws:
      // the same id carrying DIFFERENT content is not this write landing, it is
      // a collision — and for an approval item, silently adopting one would let
      // an already-answered item pass a gate nobody looked at. The compare
      // ignores `date:` drift (see stripFrontmatterDate) so it stays keyed on
      // the fact itself, not the calendar day it was re-filed on.
      const same = stripFrontmatterDate(fs.readFileSync(file, "utf8")) === stripFrontmatterDate(markdown);
      return same ? { ok: true, id, existing: true } : { ok: false, id, existing: true, reason: `${id} already exists with different content — refusing to adopt another gate's node` };
    }
    // The same validation the local `put-node` door runs: a malformed gate node
    // written straight to disk would break loadGraph for everything downstream.
    const parsed = parsePutNode(markdown, `${id}.md`);
    if (parsed.error) return { ok: false, reason: parsed.error };
    const valid = validatePutNodeLocal(dir, parsed.node, markdown);
    if (valid.error) return { ok: false, reason: valid.error };
    fs.writeFileSync(file, markdown);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function gateStem(nodeId) {
  return String(nodeId || "item")
    .replace(/^[a-z]+-/, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 30)
    .replace(/-+$/, "") || "item";
}

function gateShortRun(runId) {
  return String(runId || "").replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "unknown";
}

// The id suffix and the two body-safety helpers are the gate runner's, so the
// facts it mints and the work nodes minted here can never drift apart.
const { gateIdSuffix, fenceSafe, capBytes: gateCapBytes, NODE_BODY_CAP_BYTES } = gateRunner;

// One work-node template for the three items a gate can file. All three are
// ordinary queue items — an escalation and an approval carry `requires: [human]`
// so no worker (this one included) can ever claim them, which is what makes
// "escalates to a human" true rather than decorative. The one item that IS for
// a worker — the test-change lane item — is stamped `readiness: agent`:
// without the stamp it would derive UNTRIAGED and the default accept policy
// (work.accept ready, dec-spor-work-accept-policy-configurable) would leave it
// unworked forever. The consent the stamp records is real, just upstream: the
// operator declared the lane's profile in the factory definition.
function buildGateWorkNode({ id, title, summary, body, project, date, edges = [], requiresHuman = false, profile = null }) {
  // The frontmatter parser is line-based: a title or summary carrying a newline
  // (a git message, a suite's first failing line) would truncate the node. Flatten
  // and cap both, the same discipline the dispatch report artifact keeps.
  const flat = (text, cap) => {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
  };
  const lines = [
    "---",
    `id: ${id}`,
    "type: task",
    ...(project ? [`project: ${project}`] : []),
    `title: ${flat(title, 120)}`,
    `summary: ${flat(summary, 460)}`,
    `date: ${date}`,
    ...(requiresHuman ? ["requires: [human]"] : ["readiness: agent"]),
    ...(profile ? [`profile: ${profile}`] : []),
    ...(edges.length ? ["edges:", ...edges.map((e) => `  - {type: ${e.type}, to: ${e.to}}`)] : []),
    "---",
    "",
    body,
    "",
  ];
  // The server rejects a node whose BODY exceeds 8192 bytes outright, and these
  // bodies are unbounded by construction — 20 findings, a suite tail, one line
  // per protected path. An escalation nobody could file is a gate refusal
  // nobody is told about, so the body is trimmed here rather than lost there.
  return gateCapBytes(lines.join("\n"), NODE_BODY_CAP_BYTES - 512);
}

// How an approval item is READ (WORKERS.md §10.5). Deliberately not the
// dispatch guard's "is this resolved?" reading, whose terminal-status branch
// counts every retiring status — `closed`, `superseded`, `abandoned` — as
// resolved. That polarity is right for "would dispatching this redo finished
// work" and exactly wrong here, where it would turn a dismissal into an
// approval. So: a live inbound RESOLVING edge approves; any other terminal
// status is a refusal; anything else is still pending.
async function gateApprovalState(cfg, id) {
  const node = await resolveNode(cfg, id);
  if (!node) return { state: "pending" };
  const status = (node.status || "").toLowerCase();
  if (node.resolution && node.resolution.by) return { state: "approved", by: node.resolution.by };
  if (cfg.mode() !== "remote") {
    // Local mode has no server-side `resolution` enrichment; read the same
    // inbound-resolver join off the loaded graph (the resolution kernel), which
    // also sees a graph-resident schema's non-resolving statuses.
    try {
      // Cached, not a raw loadGraph: this is called on the gate's poll
      // interval for up to approvalTimeoutMs (a day by default, ~1440 polls
      // at the 60s floor) from one live worker process, and the overwhelming
      // majority of polls find the graph unchanged
      // (task-spor-gate-approval-poll-graph-load). u.loadGraphCached is the
      // same process-lifetime, mtime-fingerprinted memo the local-mode hooks
      // already use for the equivalent per-invocation load
      // (issue-cc-local-mode-hook-load-latency) — reused here rather than
      // grown a second time.
      const { graph: g } = u.loadGraphCached(cfg.nodesDir());
      const r = resolutionOf(g, id);
      if (r && r.by) return { state: "approved", by: r.by };
      const n = g.nodes[id];
      if (n && isTerminalStatus(n.status, n.type, g)) return { state: "rejected", by: status };
      return { state: "pending" };
    } catch {
      // An unreadable graph is not an approval.
      return { state: "pending" };
    }
  }
  // Remote: the server already told us there is no resolver, so a terminal
  // status can only be a non-resolving one.
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  // The TIERED rule (dec-spor-offline-inert-tiered-fallback): a server-computed
  // `inert` is authoritative BOTH ways, and only a server that said nothing
  // falls through to the offline seed check. Written as `inert === true || …`
  // an explicit `false` would be overruled by a seed pack that has not seen this
  // graph's resident schema — refusing an approval the person is still owed.
  if (graphLib.isNodeInertOffline(node.inert, status, node.type || null)) {
    return { state: "rejected", by: status };
  }
  return { state: "pending" };
}

// --- demoting a refused item (WORKERS.md §10.7) ----------------------------
// A gate runs AFTER the run wrote its resolver, so a refused claim is one the
// graph is already carrying as finished. Cooling the node off is machine-local;
// every other reader would go on reading it as done. Demotion is how a refusal
// becomes graph state:
//
//   1. the person's item the gate filed (escalation, approval, test-change
//      lane) carries `blocks` onto the work item — written into that node at
//      file time, so the dependency lands in ONE validated write and cannot be
//      half-applied;
//   2. the work item's own COMPLETION status is rolled back here, so no read
//      surface reports the gated claim as finished while the gate says it is
//      not. `spor get` then shows the ⚠ the schema's read hook already emits
//      for an open status contradicting a resolving edge.
//
// The resolving EDGE is deliberately NOT retracted. This client has no
// edge-removal door at all, and the resolver node is the agent's own durable
// record of what it did — deleting the link would destroy evidence to express a
// verdict. The escalation is what tells a person to judge it, and a person who
// agrees with the gate retires the resolver themselves.
//
// A PASSING gate never re-flips the status either: writing `done` would be the
// runner asserting completion, and a gate records what was enforced — it does
// not retire anything (dec-spor-gates-enforced-in-code-factory-is-data).

// The statuses a gate may roll BACK: a claim of COMPLETION. Deliberately not
// the give-up words (`abandoned`, `rejected`, `dismissed`, `closed`, …) — a
// gate refuses a claim that the work is finished; it never reopens a decision a
// person made to drop the work. The type's own declared `status.completion`
// wins wherever the registry is readable (registry is the contract); this is
// the fallback for a remote graph whose registry this client cannot load.
const GATE_COMPLETION_FALLBACK = new Set(["done", "resolved", "completed", "answered"]);
// gatePromoteItem's remote-mode inverse of the set above: which completion
// value a given TYPE reads, when there is no local registry to ask.
const GATE_TYPE_COMPLETION_FALLBACK = { issue: "resolved", incident: "resolved", question: "answered", task: "done" };
// What a rolled-back item reads instead. `open` is the live entry value of
// every queueable type's vocabulary (task, issue, question); a type whose
// vocabulary refuses it fails the write, which is reported, not swallowed.
const GATE_DEMOTED_STATUS = "open";

// Roll one item's completion status back. {ok, demoted, note} — `demoted:false`
// with `ok:true` is the ordinary case where there was nothing to roll back (the
// item never went to a completion status, which is every local-mode
// `reported` run).
//
// A blocker id is REQUIRED (task-spor-gate-escalation-demote-atomic,
// issue-spor-integration-settle-escalate-demote-race): a rollback with nothing
// on the graph blocking the item is the worst state there is — open,
// agent-ready, unblocked, its resolving edge standing. Every caller (the gate
// pipeline's refusal, the integration stage's settle() and park(), the
// proposal heal pass) now withholds the demotion until it has one, so this is
// the door refusing rather than the last line of defence being crossed.
async function gateDemoteItem(cfg, id, { blockerId = null } = {}) {
  if (!blockerId) return { ok: false, reason: `nothing blocks ${id} — a demotion is refused until the item that would block it exists (WORKERS.md §10.7)` };
  const blocked = `${blockerId} now blocks ${id}`;
  const node = await resolveNode(cfg, id);
  if (!node) return { ok: false, reason: `${id} could not be re-read, so its status could not be rolled back` };
  const status = String(node.status || "").trim().toLowerCase();
  // Every path below returns a NOTE saying what happened, including the
  // do-nothing ones. A demotion that silently did nothing reads exactly like
  // one that worked, and this feature exists to stop refusals going quiet.
  if (!status) return { ok: true, demoted: false, note: `${id} carries no status to roll back; ${blocked}` };

  // The type's own declared completion value, whenever the registry is here to
  // be read. Remotely it is not (a local nodes dir, if any, is a DIFFERENT
  // graph), so the fallback set stands in.
  let completion = null;
  let graph = null;
  if (cfg.mode() !== "remote") {
    try {
      const graphLib = require(path.join(ROOT, "lib", "graph.js"));
      graph = graphLib.loadGraph(cfg.nodesDir());
      // The declared completion policy, through the registry's own accessor
      // (registry is the contract) rather than a second hand-rolled reach into
      // the schema payload.
      if (node.type) completion = graph.registry.completionStatus(node.type);
    } catch {
      graph = null; // an unreadable graph falls through to the fallback set
    }
  }
  const isCompletion = completion ? status === completion : GATE_COMPLETION_FALLBACK.has(status);
  if (!isCompletion || status === GATE_DEMOTED_STATUS) {
    return { ok: true, demoted: false, note: `${id} reads '${status}', which is not a claim of completion — nothing to roll back; ${blocked}` };
  }

  const wrote = await gateWriteStatus(cfg, id, GATE_DEMOTED_STATUS, graph);
  if (!wrote.ok) return { ok: false, reason: wrote.reason };
  return {
    ok: true,
    demoted: true,
    note: `${id} rolled back ${status} -> ${GATE_DEMOTED_STATUS}; ${blocked}`,
  };
}

// The status write itself, through the same doors `spor set-status` uses but
// without its CLI chatter (`setStatusLocal` is the shared local body, so the
// two cannot drift).
//
// Remotely, the endpoint CLAIMS a node it moves to an active status. The gate
// is not claiming anything — the whole point of the demotion is that a PERSON
// must now judge the item — so a lease this write incidentally established is
// handed straight back. Only one this call established: a `lease.error` means
// someone else holds it, and releasing that would strand whoever does.
async function gateWriteStatus(cfg, id, value, graph = null) {
  if (cfg.mode() === "remote") {
    const r = await remote.post(cfg, `/v1/nodes/${encodeURIComponent(id)}/status`, { status: value }, { timeoutMs: 8000 });
    if (r.transport) return { ok: false, reason: `offline — ${r.error}` };
    if (!r.ok) {
      const e = (r.json && r.json.error) || {};
      return { ok: false, reason: `status ${r.status}${e.message ? `: ${e.message}` : ""}` };
    }
    const lease = r.json && r.json.lease;
    if (lease && !lease.error) {
      // Best effort: a release that fails leaves a lease that lapses on its own
      // TTL, which is no worse than not trying — and must never turn a landed
      // demotion into a reported failure.
      try {
        await remote.post(cfg, `/v1/nodes/${encodeURIComponent(id)}/release`, {}, { timeoutMs: 6000 });
      } catch {
        /* the lease lapses */
      }
    }
    return { ok: true };
  }
  return setStatusLocal(cfg, id, value, { graph });
}

// The mirror of gateDemoteItem, for propose mode's later half
// (task-spor-integration-propose-mode): once checkProposal confirms a PR
// merged, the resolution the item's own dispatched run already wrote finally
// stands — restore the completion status park() rolled back, so every read
// surface goes back to reporting the item as finished.
//
// Only ever restores a status this mechanism could plausibly have rolled back
// (GATE_DEMOTED_STATUS). A node a person independently moved on from since —
// abandoned it, or re-dispatched it and it is genuinely `open` for an
// unrelated reason — is left alone: there is no way to tell those apart from
// a bare status field, and the safe direction is "do nothing" rather than
// guess a completion the item may no longer deserve.
async function gatePromoteItem(cfg, id) {
  const node = await resolveNode(cfg, id);
  if (!node) return { ok: false, reason: `${id} could not be re-read, so its status could not be restored` };
  const status = String(node.status || "").trim().toLowerCase();
  if (status !== GATE_DEMOTED_STATUS) {
    return { ok: true, restored: false, note: `${id} reads '${status || "(none)"}', not '${GATE_DEMOTED_STATUS}' — nothing to restore` };
  }
  let completion = null;
  let graph = null;
  if (cfg.mode() !== "remote") {
    try {
      const graphLib = require(path.join(ROOT, "lib", "graph.js"));
      graph = graphLib.loadGraph(cfg.nodesDir());
      if (node.type) completion = graph.registry.completionStatus(node.type);
    } catch {
      graph = null; // an unreadable graph falls through to the fallback guess below
    }
  }
  // The remote-mode fallback guess (no local registry to ask): mirrors
  // GATE_COMPLETION_FALLBACK's own type coverage, not just the two types
  // gateDemoteItem's caller happens to see most — a demoted `question`
  // restores to `answered`, never a task's `done`.
  const target = completion || GATE_TYPE_COMPLETION_FALLBACK[node.type] || "done";
  const wrote = await gateWriteStatus(cfg, id, target, graph);
  if (!wrote.ok) return { ok: false, reason: wrote.reason };
  return { ok: true, restored: true, note: `${id} restored ${GATE_DEMOTED_STATUS} -> ${target}` };
}

// What the review prompt carries of the change itself: the diff, embedded and
// bounded (a reviewer that reads an unbounded, growing diff in the
// implementer's live checkout is the memoryless posture this gate moved away
// from). Past the cap the prompt still names the git command for the rest.
const GATE_DIFF_CAP_BYTES = 48 * 1024;
function gateDiffText(change) {
  const r = git(change.cwd, ["diff", "--no-color", "--no-ext-diff", `${change.base}..${change.head}`], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    return { text: `(the diff could not be read: ${(r.stderr || "").trim().split("\n")[0] || "git diff failed"})`, truncated: false };
  }
  const text = String(r.stdout || "");
  if (Buffer.byteLength(text, "utf8") <= GATE_DIFF_CAP_BYTES) return { text, truncated: false };
  return { text: gateRunner.capBytes(text, GATE_DIFF_CAP_BYTES), truncated: true };
}

// `git log --stat` over a commit range, capped in bytes — the one composition
// both the fix-cycle context and the rescue lane's whole-branch history are
// built from. Empty when the range is empty or cannot be read.
function gateLogText(change, from, to, cap) {
  const log = git(change.cwd, ["log", "--no-color", "--format=%h %s%n%b", "--stat", `${from}..${to}`], { maxBuffer: 8 * 1024 * 1024 });
  if (log.status !== 0 || !String(log.stdout || "").trim()) return "";
  return gateRunner.capBytes(String(log.stdout).trim(), cap);
}

// What the last fix cycle did, for the next review: the fixer's commits (the
// message is where it names the finding ids it addressed) and their stat — so
// the reviewer answers "was F2 fixed" against what changed, not from scratch.
// Falls back to naming the run when the heads are not known.
function gateFixText(change, fix) {
  const lines = [];
  const ids = (fix.findings || []).filter((f) => f.blocking !== false && f.id).map((f) => f.id);
  if (fix.runId) lines.push(`Fix cycle ${(fix.cycle || 0) + 1} was dispatched as run ${fix.runId}${ids.length ? ` to address ${ids.join(", ")}` : ""}.`);
  if (fix.fromHead && fix.toHead && fix.fromHead !== fix.toHead) {
    const log = gateLogText(change, fix.fromHead, fix.toHead, 6000);
    if (log) lines.push("", `Commits ${fix.fromHead.slice(0, 8)}..${fix.toHead.slice(0, 8)}:`, "", "```", gateRunner.fenceSafe(log), "```");
  } else if (fix.fromHead && fix.toHead) {
    lines.push("The fix cycle added NO commits — the tree is exactly what the previous review judged.");
  }
  return lines.join("\n");
}

// Every commit on the branch — the implementer's and each fix cycle's — for
// the rescue lane, which is handed the whole history rather than only the
// last fix (task-spor-factory-rescue-lane).
function gateHistoryText(change) {
  if (!change || !change.base || !change.head || change.base === change.head) return "";
  return gateLogText(change, change.base, change.head, 8000);
}

// The work item as the reviewer should see it: id, title, summary and the
// body (bounded) — what was asked, so "does it do what was asked" has a
// referent.
function gateWorkItemText(node) {
  const raw = String(node.raw || "");
  let body = "";
  if (raw.startsWith("---\n")) {
    const end = raw.indexOf("\n---", 4);
    if (end !== -1) body = raw.slice(end + 4).trim();
  }
  const parts = [node.title ? `${node.id}: ${node.title}` : node.id];
  if (node.summary) parts.push("", node.summary);
  if (body) parts.push("", gateRunner.capBytes(body, 4000));
  return parts.join("\n");
}

// The deps one gate pipeline runs on: git plumbing against THIS run's tree,
// dispatches through the real `spor dispatch`, and graph writes through the
// validated node door. `dispatch` and `home` are overridable ONLY so a test
// can fake the launch without spawning a real agent; the real caller (cmdWork)
// never passes either, so it gets the live `dispatchThrough` and this box's
// config home, byte-identical to before either param existed.
// The keys of the worker's passthrough that describe the IMPLEMENTER's
// harness — `--permission-mode` is Claude Code's, `--sandbox`/`--approval-
// policy` are Codex's, `--agent` is Claude Code's, and `--model` names a
// model of the worker's harness. A review runs under the GATE's profile,
// routinely a different harness whose adapter rejects a foreign flag outright
// (rejectForeignOptions) — so a claude-code worker's `--permission-mode
// bypassPermissions` refused every OpenCode/Copilot review before it launched
// (review finding 5 on the third cut). Only the harness-neutral keys ride to
// a review; the profile is the gate's and the posture is `--read-only`. The
// FIX dispatch keeps the full passthrough: it runs in the worker's own lane.
// Derived from the harness module's ONE flag list (HARNESS_OPTION_FLAGS), so a
// new harness flag lands here without a second edit
// (issue-spor-rescue-posture-foreign-restrictive-flag-becomes-bypass).
const REVIEW_HARNESS_FLAGS = Object.keys(dispatchHarnesses.HARNESS_OPTION_FLAGS).concat(["model"]);
function reviewPassthrough(passthrough) {
  const out = { ...(passthrough || {}) };
  for (const k of REVIEW_HARNESS_FLAGS) delete out[k];
  return out;
}

// The two halves of an implementer's passthrough, as a RESCUE has to read them
// (issue-spor-rescue-dispatch-drops-harness-flags). ROUTING says WHO runs —
// and a rescue routes to the lane's profile precisely because that profile
// names a stronger model, so the worker's `--model` (which OVERRIDES a
// profile's own model — cmdDispatch's `effectiveModel`) and its `--agent` (a
// Claude Code agent DEFINITION belonging to the worker's lane) must not ride.
// POSTURE says HOW the box runs — unattended or not — and a rescue is an
// implementer that commits into the run's own checkout, so it needs the
// worker's posture exactly as a fix cycle does: a claude-code rescue launched
// without the worker's `--permission-mode bypassPermissions` stalls on its
// first write prompt with nobody there to answer it.
const RESCUE_ROUTING_FLAGS = ["model"].concat(Object.keys(dispatchHarnesses.harnessOptionFlags("routing")));
// The posture flags, each mapped to the option key an adapter's
// `validateOptions` reads it under.
const RESCUE_POSTURE_FLAGS = dispatchHarnesses.harnessOptionFlags("posture");

// The worker's passthrough as the rescue's own harness can read it. The
// posture is spelled in the WORKER's harness vocabulary and the lane routinely
// runs a different one, where a foreign flag is refused outright
// (rejectForeignOptions) — so the rescue's ADAPTER is the judge of what rides,
// never a second table here (norm-cc-registry-is-contract): Claude Code takes
// `--permission-mode`, Codex takes it too (its `validateOptions` TRANSLATES
// bypassPermissions into `--sandbox danger-full-access --ask-for-approval
// never`, the same translation the fix cycle gets) alongside its own
// `--sandbox`/`--approval-policy`, and OpenCode/Copilot take neither — they
// run unattended by default. The probe is per FLAG (a posture the lane's
// harness does own must not be dropped because a foreign sibling rode beside
// it), and an unknown or unreadable harness keeps the posture, so the mistake
// surfaces as dispatch's own loud refusal rather than as a silently attended
// rescue.
//
// A flag the lane cannot read is not simply dropped: it is translated BY
// MEANING (issue-spor-rescue-posture-foreign-restrictive-flag-becomes-bypass).
// The worker's whole posture is read by the adapters that own its flags
// (dispatchHarnesses.postureMeaning — read-only / attended / unattended, the
// most restrictive reading winning) and re-expressed in the lane harness's own
// declarations: read-only becomes the lane's `--read-only` posture (dispatch
// applies the adapter's `readOnly`, and refuses loudly on a harness without
// one) and displaces every posture flag, since a read-only worker's rescue
// must not be able to write more than the worker could; unattended fills in
// the lane's declared `unattended` posture (`--permission-mode
// bypassPermissions` on claude-code, empty on every harness that needs no
// flag); attended fills in the lane's declared `attended` posture (empty on
// claude-code, where every mode but plan/bypass asks; `--approval-policy
// on-request` on Codex, whose argv otherwise defaults to never asking) — and
// where the lane declares NO attended posture (OpenCode/Copilot, whose
// `--auto`/`--allow-all` cannot be unsaid) it NARROWS to the lane's
// `--read-only`, the next reading down, never up to the unattended default.
// Either way every surviving posture flag is displaced first: a worker whose
// bypass rode beside a foreign approval policy that gates on prompts reads as
// attended, and the bypass must not be left standing to widen it. Only an
// EMPTY posture (a worker on a harness that needs no flag at all) takes the
// lane's unattended posture without a reading, since there is nothing to
// read. Every drop, translation and substitution is REPORTED — changing what
// an unattended agent may do has to be visible.
function rescuePassthrough(passthrough, adapter) {
  const out = { ...(passthrough || {}) };
  for (const k of RESCUE_ROUTING_FLAGS) delete out[k];
  const dropped = [];
  const applied = [];
  let translated = null;
  if (!adapter || typeof adapter.validateOptions !== "function") return { values: out, dropped, applied, translated };
  // The worker's whole posture, as the adapters read it.
  const posture = {};
  for (const [flag, option] of Object.entries(RESCUE_POSTURE_FLAGS)) if (out[flag]) posture[option] = out[flag];
  for (const [flag, option] of Object.entries(RESCUE_POSTURE_FLAGS)) {
    if (!out[flag]) continue;
    // `agent` is already gone above, and Codex checks it BEFORE the permission
    // mode it translates — passing it here would mask that translation with a
    // refusal the rescue never earned.
    const check = adapter.validateOptions({ permissionMode: null, agent: null, sandbox: null, approvalPolicy: null, [option]: out[flag] });
    if (!check || !check.message) continue;
    delete out[flag];
    dropped.push({ flag, value: posture[option], message: check.message });
  }
  const spelled = (flags) => flags.map((d) => `--${d.flag} ${d.value}`).join(" ");
  if (dropped.length) {
    // Something the lane cannot read was said: translate what the WHOLE
    // posture means. A posture whose flags no adapter owns cannot happen (each
    // posture flag has an owner), but if it did, attended is the safe reading.
    const meaning = dispatchHarnesses.postureMeaning(posture) || "attended";
    translated = { meaning, from: spelled(dropped) };
    if (meaning === "read-only") {
      for (const flag of Object.keys(RESCUE_POSTURE_FLAGS)) delete out[flag];
      out["read-only"] = true;
      applied.push({ flag: "read-only", value: true });
    } else if (meaning === "attended") {
      // Displace what survived (a bypass beside the foreign attended flag
      // would otherwise stand), then say attended the lane's own way — or,
      // where the lane has no attended spelling, narrow to read-only.
      for (const flag of Object.keys(RESCUE_POSTURE_FLAGS)) delete out[flag];
      if (adapter.attended) {
        for (const [flag, option] of Object.entries(RESCUE_POSTURE_FLAGS)) {
          if (!adapter.attended[option]) continue;
          out[flag] = adapter.attended[option];
          applied.push({ flag, value: adapter.attended[option] });
        }
      } else {
        translated.narrowed = true;
        out["read-only"] = true;
        applied.push({ flag: "read-only", value: true });
      }
    } else if (meaning === "unattended" && adapter.unattended) {
      for (const [flag, option] of Object.entries(RESCUE_POSTURE_FLAGS)) {
        if (!adapter.unattended[option] || out[flag]) continue;
        out[flag] = adapter.unattended[option];
        applied.push({ flag, value: adapter.unattended[option] });
      }
    }
  } else if (!Object.keys(posture).length && adapter.unattended) {
    // Nothing of a posture was said at all: the worker is on a harness that
    // needs no flag to run unattended (Codex, OpenCode, Copilot), and the
    // lane's may not be — claude-code stalls on its first write without one.
    // Express the LANE harness's own declared unattended posture
    // (`adapter.unattended`, beside `readOnly` — never a table here); empty
    // for every harness that needs no flag, the bypass on claude-code, and
    // said out loud because a posture nobody typed is being applied.
    for (const [flag, option] of Object.entries(RESCUE_POSTURE_FLAGS)) {
      if (!adapter.unattended[option]) continue;
      out[flag] = adapter.unattended[option];
      applied.push({ flag, value: adapter.unattended[option] });
    }
  }
  return { values: out, dropped, applied, translated };
}

// The harness the rescue's profile launches under, read the way the factory
// precheck reads it — off whatever frontmatter is there, with no `type:
// profile` gate, defaulting to claude-code — so the worker's posture can be
// filtered to what that harness accepts. Fail-soft: an unreadable profile or
// an unknown harness yields null and the posture rides untouched.
async function rescueHarnessAdapter(cfg, profileId) {
  try {
    const pn = await resolveNode(cfg, profileId);
    if (!pn || !pn.raw) return null;
    const profile = require(path.join(ROOT, "lib", "graph.js")).parseFrontmatter(pn.raw, `${profileId}.md`);
    const harness = (typeof profile.harness === "string" && profile.harness) || "claude-code";
    return dispatchHarnesses.resolveHarness(harness, { cfg }).adapter || null;
  } catch {
    return null;
  }
}

// The run record of a fix cycle this pipeline already launched under `name`
// for `nodeId`, if one exists — the launcher writes a run's record before
// `dispatch` returns, so a launch the pipeline's own bookkeeping never got to
// record is still findable by its name. Newest first; null when none.
function launchedFixRun(home, nodeId, name) {
  try {
    const hit = dispatchRuns.listRuns(home, { node: nodeId }).find((r) => r && r.name === name && r.run_id);
    return hit ? { run_id: hit.run_id, harness: hit.harness || null, adopted: true } : null;
  } catch {
    return null;
  }
}

function makeGateDeps(
  cfg,
  { record, entry, factory, slug, passthrough, warn, sleep, log, runMaxMs = workLoop.WORK_DEFAULTS.runMaxMs, stopping = () => false, dispatch = dispatchThrough, home = cfg.userConfigHome() }
) {
  const date = () => new Date().toISOString().slice(0, 10);
  const stem = gateStem(entry.node_id);
  // A re-gate (entry.attempt > 1) mints ids under an attempt-scoped key so its
  // facts and escalations never collide with the first attempt's.
  const short = gateRunner.shortRunAttempt(entry.run_id, entry.attempt);
  const runKey = gateRunner.gateRunKey(entry.run_id, entry.attempt);
  // A RESCUE pass (task-spor-factory-rescue-lane) re-runs the gates on the
  // same run; everything it files or names is keyed one segment deeper so it
  // never collides with — or silently adopts — the original pass's node.
  // Pass 0 hands back the exact keys above.
  const keysFor = (rescue) => (rescue ? { short: gateRunner.shortRunAttempt(entry.run_id, entry.attempt, rescue), runKey: gateRunner.gateRunKey(entry.run_id, entry.attempt, rescue) } : { short, runKey });
  const progressKey = (gate, rescue) => (rescue ? `${gate.id}#x${rescue}` : gate.id);
  let change = null;
  // The work item's own text, read once for the review prompt: a reviewer
  // judging "does this do what was asked" has to be told what was asked.
  let itemText = null;
  const workItemText = async () => {
    if (itemText !== null) return itemText;
    try {
      const node = await resolveNode(cfg, entry.node_id);
      itemText = node ? gateWorkItemText(node) : "";
    } catch {
      itemText = "";
    }
    return itemText;
  };

  // The review prompt (task-spor-review-gate-stateful-bounded). Everything the
  // reviewer needs is IN the prompt — the work item, the diff itself, the
  // prior findings with the ids the ledger gave them, the fix the last cycle
  // made — so review N does not restart from nothing in the implementer's
  // checkout and raise a fourth new finding where three were already open.
  // The verdict protocol it is asked to follow is the one
  // gates.parseReviewVerdict enforces; the prose here only explains it.
  const review = async ({ gate, cycle, prior = [], raised = [], fix = null, rescue = 0, base = 0 }) => {
    if (!change) return { ok: false, reason: "the change under review could not be read" };
    const cap = gatesKernel.cycleCap(gate);
    // On a rescue pass the cycle index continues (so the stateful protocol
    // treats the rescue's fix as a fix), but the budget the reviewer is told
    // about is the rescue pass's own, counted from `base`.
    const shown = rescue ? cycle - base : cycle;
    const item = await workItemText();
    const diff = gateDiffText(change);
    const fixText = fix ? gateFixText(change, fix) : "";
    // How many fix cycles each prior finding has already survived, and the
    // rows an earlier review enumerated for it: a finding carried a second
    // time must be answered with the mechanism's rows (below), not the next
    // one (task-spor-review-gate-carried-finding-names-the-mechanism-not-the-
    // next-row).
    const carriedOf = (p) => gatesKernel.carriedFixCycles(p, cycle);
    const secondCarry = prior.filter((p) => carriedOf(p) >= gatesKernel.ROW_BY_ROW_CARRY);
    const priorText = prior
      .map(
        (p) =>
          `${p.id} [${p.severity}${carriedOf(p) ? `, carried ${carriedOf(p)} fix cycle${carriedOf(p) === 1 ? "" : "s"}` : ""}] ${p.file ? `${p.file} — ` : ""}${p.summary}` +
          (p.evidence ? `\n    evidence: ${String(p.evidence).replace(/\s+/g, " ").slice(0, 400)}` : "") +
          gatesKernel.mechanismRows(p.rows).map((r) => `\n    row (enumerated by the last review${Number.isInteger(p.rowsCycle) ? `, cycle ${p.rowsCycle}` : ""}): ${r}`).join("") +
          // An enumeration the LAST review did not re-confirm is replayed as
          // history, never as the current row list (F1 on the second cut).
          (gatesKernel.mechanismRows(p.rows).length ? [] : gatesKernel.mechanismRows(p.earlierRows))
            .map((r) => `\n    row (enumerated at ${Number.isInteger(p.earlierRowsCycle) ? `cycle ${p.earlierRowsCycle}` : "an earlier cycle"}, NOT re-confirmed by the last review — re-enumerate if it still stands): ${r}`)
            .join("")
      )
      .join("\n");
    const raisedText = raised
      .map((p) => `${p.id} [${p.severity}, undemonstrated at cycle ${p.opened}] ${p.file ? `${p.file} — ` : ""}${p.summary}`)
      .join("\n");
    const verdictShape =
      `{"verdict": "pass" | "changes_requested",` +
      (prior.length ? ` "prior": [{"id": "${prior[0].id}", "status": "resolved" | "open", "note": "what you checked", "rows": ["each remaining row of the mechanism, when open"]}],` : "") +
      ` "findings": [{"severity": "blocking|major|minor", "file": "path", "summary": "what is wrong", "evidence": "the command/test you ran and what it showed"` +
      (cycle > 0 ? `, "introduced_by_fix": true | false` : "") +
      `}]}`;
    const prompt = [
      `You are the '${gate.id}' review gate for Spor work item ${entry.node_id}` +
        (rescue
          ? shown === 0
            ? ` (the review after the rescue lane's fix, rescue attempt ${rescue} — judge the rescue's commits as a fix cycle).`
            : ` (the review after fix cycle ${shown} of ${cap} of rescue attempt ${rescue}).`
          : cycle === 0
            ? " (the initial review)."
            : ` (the review after fix cycle ${cycle} of ${cap}).`),
      "You are running READ-ONLY. Do NOT edit any file, do NOT commit, and do NOT resolve, close, or write any Spor node:",
      "you are a gate, not an implementer. Run commands and tests freely to check your claims.",
      "",
      "## The work item",
      "",
      item || `(the node ${entry.node_id} could not be read — judge the change against its commit messages)`,
      "",
      "## The change",
      "",
      `\`git diff ${change.base}..${change.head}\` in ${change.cwd} (${Array.isArray(change.paths) ? change.paths.length : "?"} file(s)):`,
      "",
      "```diff",
      gateRunner.fenceSafe(diff.text),
      "```",
      diff.truncated ? `(diff truncated at ${Math.round(GATE_DIFF_CAP_BYTES / 1024)}KB — run the git command above for the rest)` : "",
      "",
      ...(prior.length
        ? [
            "## Prior findings — answer these FIRST",
            "",
            "Earlier cycles of this gate raised the following BLOCKING findings, which the implementer was sent to fix.",
            "For EACH one, check the current tree and say whether the fix resolved it (`prior` in the verdict):",
            "",
            priorText,
            "",
            ...(fixText ? ["## What the last fix cycle changed", "", fixText, ""] : []),
            "A verdict that omits any prior finding (neither cleared nor confirmed) is UNREADABLE and counts as",
            "changes_requested for the prior set only — nothing new you raise is admitted in that case.",
            "",
            "### A carried finding names the MECHANISM, not the next row",
            "",
            "When you confirm a prior finding open, do not answer with the next failing case. Name the mechanism the",
            "finding is one instance of (the thing every case has in common — a stream the client reads text off, a",
            "flag one pass writes for another, a path spelling), enumerate EVERY remaining row of it you can see as",
            "`rows` on that prior entry (one string per row — the cases one fix would have to close together), and say",
            "in the note which rows the fix must close for the finding to resolve. A fix closes the row it was shown;",
            "a finding answered one row per cycle spends the whole cycle budget on one mechanism.",
            ...(secondCarry.length
              ? [
                  "",
                  `${secondCarry.map((p) => p.id).join(", ")} ${secondCarry.length === 1 ? "has" : "have"} already been carried through ${gatesKernel.ROW_BY_ROW_CARRY} or more fix cycles: if you confirm ${secondCarry.length === 1 ? "it" : "any of them"} open, \`rows\``,
                  "is REQUIRED — a confirmation naming fewer than two rows is recorded as row-by-row on the finding and on the",
                  "gate's fact, and the fixer is told to enumerate the rows itself.",
                ]
              : []),
            "",
          ]
        : []),
      "## What to look for",
      "",
      gate.instructions || "Look for correctness defects: does this change do what the work item asked, and does it break anything?",
      "",
      "## Durable retry/debt flags — review the mechanism WHOLE, in this one verdict",
      "",
      "If the change introduces or extends a durable retry/debt flag — a `*_pending` field on a run record, a journal",
      "line, a cooldown file, an outbox entry: anything one pass writes so a later pass owes an action — walk EVERY",
      "row below against it and file every row that is open in THIS verdict, each as its own finding naming the row.",
      "Do not raise one row now and the next after the fix: a flag reviewed one failure mode per cycle spends the",
      "whole cycle budget on one design.",
      "",
      gatesKernel.renderDurableFlagChecklist(),
      "",
      ...(cycle > 0
        ? [
            "On a fix cycle, walk the table again against the writes the fix added or reordered: a row the fix",
            "INTRODUCED is blocking (`introduced_by_fix: true`); a row that was open at the initial review and was not",
            "raised then is advisory now.",
            "",
          ]
        : []),
      ...(raised.length
        ? [
            "## Earlier findings rated blocking but not demonstrated",
            "",
            "These were recorded as advisory because no command or test backed them. If you can DEMONSTRATE one now,",
            "raise it again under `findings` with ITS id and `evidence`; it then counts as raised at its original cycle.",
            "",
            raisedText,
            "",
          ]
        : []),
      "## Severity — only `blocking` blocks",
      "",
      "- `blocking`: a correctness defect, silent data loss, or contract break that MUST be fixed before this lands —",
      "  and that you DEMONSTRATED: `evidence` names the command or test you ran and what it showed. A blocking",
      "  finding without evidence is recorded as advisory, not enforced — a `changes_requested` backed ONLY by",
      "  undemonstrated blocking findings passes with those findings recorded as advisory. Demonstrate what you block on:",
      "  `evidence` is a string naming what you ran; `true`, `yes` or a bare affirmation is not evidence.",
      ...(cycle > 0
        ? [
            "- On a fix cycle, a NEW blocking finding must be one the fix INTRODUCED (`introduced_by_fix: true`). A defect",
            "  that was there at the initial review and was not raised then is advisory now — record it, do not block on it.",
          ]
        : []),
      "- `major` / `minor`: worth noting, never a reason to fail the gate. Style, naming and formatting are minor.",
      "",
      "End your final message with your verdict as a fenced json block, exactly this shape:",
      "```json",
      verdictShape,
      "```",
      `Use "pass" only when nothing blocking remains${prior.length ? " — including every prior finding you confirmed" : ""}. An unreadable verdict counts as changes_requested.`,
    ].join("\n");
    const launched = await dispatch(
      cfg,
      { ...reviewPassthrough(passthrough), profile: gate.profile, dir: change.cwd, "no-brief": true, "no-worktree": true, "read-only": true, name: `gate-${gate.id}-${keysFor(rescue).short}-${cycle}` },
      [prompt]
    );
    if (!launched.ok) return { ok: false, reason: `the review under ${gate.profile} could not be dispatched: ${launched.reason}` };
    const done = await awaitGateRun(cfg, launched.run.run_id, { timeoutMs: gate.awaitMs, warn, sleep });
    if (!done.ok) return { ok: false, reason: done.reason };
    const text = gateRunReportText(done.record);
    if (!text.trim()) {
      return {
        ok: false,
        reason:
          `the review run under ${gate.profile} left no final report to read a verdict from` +
          ` (an agent-review gate must route to a SUPERVISED harness — a native background launch has no report channel)`,
      };
    }
    return { ok: true, text, runId: launched.run.run_id };
  };

  const fix = async ({ gate, cycle, findings, detail, evidence, ledger, onLaunch = null, rescue = 0, base = 0 }) => {
    // The one place the worker deliberately passes --force. The loop never
    // does (a loop that forces past the resolved/duplicate guards is the
    // runaway a pull worker must not be), but here the runner KNOWS why the
    // node reads resolved — its own gate just refused that resolution — and the
    // cycle cap bounds how often this can happen before a person is asked.
    //
    // A review gate's findings arrive classified (blocking / advisory) and
    // named by ledger id; the fixer is told to name the ids it addressed so
    // the next review can answer "was F2 fixed" against its commits.
    const blocking = (findings || []).filter((f) => f.blocking !== false);
    const advisory = (findings || []).filter((f) => f.blocking === false);
    const resolved = (ledger || []).filter((e) => e.status === "resolved");
    // The blocking findings that already survived a fix cycle: the fixer is
    // asked to enumerate the mechanism's rows itself and say which the fix
    // closes and which it leaves, so the next review reads a design rather
    // than the next probe (task-spor-review-gate-carried-finding-names-the-
    // mechanism-not-the-next-row). `cycle` is the review index the findings
    // came from; the dirty-tree round-trip's `"tree"` carries nothing.
    const carriedFindings = blocking.filter((f) => gatesKernel.carriedFixCycles(f, cycle) >= 1);
    const carriedText = carriedFindings
      .map((f) => {
        const n = gatesKernel.carriedFixCycles(f, cycle);
        return `${f.id} has survived ${n} fix cycle${n === 1 ? "" : "s"}${f.rowByRow ? " and the review named only the next row (row-by-row)" : ""}`;
      })
      .join("\n");
    const prompt = [
      // The dirty-tree round-trip arrives as `cycle: "tree"` — not a fix
      // cycle, so it is never numbered against the cap on either pass.
      `The '${gate.id}' gate refused your resolution of ${entry.node_id}${rescue ? ` (rescue attempt ${rescue}${Number.isInteger(cycle) ? `, fix cycle ${cycle - base + 1} of ${gatesKernel.cycleCap(gate)}` : ""})` : cycle > 0 ? ` (fix cycle ${cycle + 1} of ${gatesKernel.cycleCap(gate)})` : ""}.`,
      "",
      detail || "",
      "",
      blocking.length ? `${blocking.some((f) => f.id) ? "Blocking findings — fix each, by id" : "Findings"}:\n${gatesKernel.renderFindings(blocking)}` : "",
      advisory.length ? `Advisory (recorded, not enforced — fix if cheap):\n${gatesKernel.renderFindings(advisory)}` : "",
      resolved.length ? `Already resolved by earlier cycles (do not regress):\n${gatesKernel.renderFindings(resolved)}` : "",
      evidence && !blocking.length ? `Evidence:\n${String(evidence).slice(0, 4000)}` : "",
      "",
      `Fix the cause in the same worktree and commit${blocking.some((f) => f.id) ? ", naming the finding ids you addressed in the commit message —" : "."}`,
      ...(blocking.some((f) => f.id) ? ["the next review is handed your commits and asked whether each prior finding is resolved."] : []),
      ...(carriedFindings.length
        ? [
            "",
            "Carried findings — close the MECHANISM, not the next row:",
            carriedText,
            "A finding that survives a fix is one instance of a mechanism, and the last fix closed the one row it was",
            "shown. Before you change anything, enumerate the mechanism's rows yourself — every case the finding can",
            "take that you can see, whether or not the review listed it (the rows it did list are under the finding",
            "above) — then fix so that ONE change closes them together, and state in the commit message which rows",
            "the fix closes and which it deliberately leaves and why. The next review reads that design; a fix that",
            "closes the row it was shown and leaves the next is a fix cycle spent.",
          ]
        : []),
      "If the fix touches a durable retry/debt flag (a `*_pending` run-record field, a journal line, a cooldown file),",
      "design it against ALL of these at once and say how each is handled in the commit message — the next review",
      "walks the whole table in one verdict, and a fix that closes one row by opening the next is a fix cycle spent:",
      gatesKernel.renderDurableFlagChecklist(),
      "The gate will re-run against the trusted ref's copy of the acceptance suite, so do not edit protected test",
      "paths — a change that touches them fails the gate closed.",
      // The one-turn notice: a fix that backgrounds its suite and ends its turn
      // waiting on it leaves the gate the dirty tree it was fixing (issue-spor-
      // rescue-and-fix-sessions-end-turn-waiting-on-background-job).
      workerContractLib.ONE_TURN_NOTICE,
    ]
      .filter((l) => l !== "")
      .join("\n");
    const fixName = `fix-${gate.id}-${keysFor(rescue).short}-${cycle}`;
    // A fix this pipeline ALREADY launched at this cycle — the worker died
    // between the launch and the durable record of it (the run-id stamp
    // below, or the runner's launched-progress save) — is adopted from its own
    // run record rather than dispatched a second time (review finding 4 on the
    // third cut). The name is unique per pipeline run, attempt, gate and
    // cycle, and the launcher writes the child's record before dispatch
    // returns, so the record exists from the first moment a crash could leave
    // the launch unrecorded.
    const already = launchedFixRun(home, entry.node_id, fixName);
    const launched = already ? { ok: true, run: already, adopted: true } : await dispatch(
      cfg,
      // `record.cwd` when the change could not be read: the commit-or-discard
      // round-trip a DIRTY tree gets (gate-runner.js runGatePipeline) runs
      // before any change set exists, and it has to land in the run's own
      // checkout — a fresh worktree would never see the uncommitted files.
      { ...passthrough, node: entry.node_id, dir: change ? change.cwd : (record && record.cwd) || undefined, force: true, "no-worktree": true, name: fixName },
      [prompt]
    );
    if (!launched.ok) return { ok: false, reason: launched.reason };
    if (launched.adopted) log(`work: gate ${gate.id} fix cycle ${cycle} on ${entry.node_id} was already launched as run ${String(launched.run.run_id).slice(0, 8)} — adopting it, not dispatching again`);
    // The fix cycle's own run is DETACHED — it outlives this worker process,
    // and the await below can run for up to `runMaxMs` (a day by default). If
    // this worker is stopped while that await is still pending, nothing else
    // ever learns which run it left in flight: the pipeline's own run record
    // (`entry.run_id`) is what the loop marks `interrupted` on exit
    // (work-loop.js runWorkLoop), so stamping the fix run's id onto it NOW —
    // before the long wait, not after — is what makes that interrupted record
    // name the orphan rather than just say "something was running"
    // (issue-spor-work-stop-abandons-inflight-gates). `stampGateState` only
    // ever writes `gate_*` fields and never clobbers a settled verdict, so this
    // can't race the loop's own interrupted/passed/failed stamp into anything
    // wrong — worst case is a stale id on a pipeline that has already settled.
    // `gate_fix_gate`/`gate_fix_cycle` say WHICH fix the stamped run is, so a
    // resumed pipeline whose progress save never landed (the crash window
    // between this stamp and `onLaunch` below) can read the launch back from
    // the stamp instead of taking the fix for undispatched (loadGateProgress).
    dispatchRuns.stampGateState(home, entry.run_id, { gate_fix_run_id: launched.run.run_id, gate_fix_at: new Date().toISOString(), gate_fix_gate: gate.id, gate_fix_cycle: cycle });
    // …and the runner charges the fix cycle to the gate's progress at this
    // same moment: launched, not merely decided on (a worker killed before
    // this line resumes INTO the fix; one killed after it resumes past it).
    if (onLaunch) {
      try {
        await onLaunch({ runId: launched.run.run_id });
      } catch (e) {
        warn(`warning: the fix cycle's launch could not be recorded on the gate's progress (${(e && e.message) || e})`);
      }
    }
    // The operator's own ceiling on how long this box follows a run (--run-max),
    // not a second hardcoded day: a fix cycle holds a gating slot exactly as a
    // dispatched run holds an active one.
    const done = await awaitGateRun(cfg, launched.run.run_id, { timeoutMs: runMaxMs, warn, sleep });
    if (!done.ok) return { ok: false, reason: done.reason };
    return { ok: true, runId: launched.run.run_id, record: done.record };
  };

  // The gate's durable memory (review finding 1 on this gate's first cut):
  // the per-gate finding ledger, fix-cycle count, attempt history and last
  // fix ride on the RUN RECORD as `gate_progress`, keyed by this attempt's
  // run key so a `--regate` (a new attempt) starts clean while a RESUMED
  // pipeline (§10.8 — same run, same attempt) reads back exactly where the
  // killed worker left each gate. Read fresh from disk, not from the record
  // this closure was handed: the fix cycle's own stamp (`gate_fix_run_id`)
  // lands on the same file, and the last fix's run id is recovered from it
  // when the progress entry never got to record it.
  const readRecordNow = () => {
    try {
      return dispatchRuns.readJson(dispatchRuns.runPaths(home, entry.run_id).record) || record || null;
    } catch {
      return record || null;
    }
  };
  const loadGateProgress = async ({ gate, rescue = 0 }) => {
    const r = readRecordNow();
    const all = r && r.gate_progress && typeof r.gate_progress === "object" ? r.gate_progress : null;
    if (!all || all.key !== runKey || !all.gates || typeof all.gates !== "object") return null;
    const p = all.gates[progressKey(gate, rescue)];
    if (!p || typeof p !== "object") return null;
    const lastFix = p.lastFix && typeof p.lastFix === "object" ? { ...p.lastFix } : null;
    if (lastFix && !lastFix.runId && r.gate_fix_run_id) lastFix.runId = r.gate_fix_run_id;
    // A fix the progress entry recorded as NOT launched, but whose launch the
    // fix closure stamped on the record (this gate, this cycle) before the
    // worker died: it launched. Read it as such — dispatched, charged — so
    // the resume reviews its result instead of dispatching it again.
    if (lastFix && lastFix.dispatched === false && r.gate_fix_run_id && r.gate_fix_gate === gate.id && r.gate_fix_cycle === lastFix.cycle) {
      lastFix.dispatched = true;
      lastFix.runId = r.gate_fix_run_id;
      return { ...p, fixes: Math.max(Number.isInteger(p.fixes) ? p.fixes : 0, lastFix.cycle + 1), lastFix };
    }
    return { ...p, lastFix };
  };
  const saveGateProgress = async ({ gate, progress, rescue = 0 }) => {
    const r = readRecordNow();
    const prev = r && r.gate_progress && r.gate_progress.key === runKey && r.gate_progress.gates && typeof r.gate_progress.gates === "object" ? r.gate_progress.gates : {};
    // The rescue lane's own entries ride beside the gates under the same key
    // (loadRescueState below) and are carried, never dropped, by a gate save.
    const carried = r && r.gate_progress && r.gate_progress.key === runKey && Array.isArray(r.gate_progress.rescue) ? { rescue: r.gate_progress.rescue } : {};
    const stamp = { key: runKey, at: new Date().toISOString(), seq: (prev && r && r.gate_progress && Number.isInteger(r.gate_progress.seq) ? r.gate_progress.seq : 0) + 1, gates: { ...prev, [progressKey(gate, rescue)]: progress }, ...carried };
    const wrote = dispatchRuns.stampGateState(home, entry.run_id, { gate_progress: stamp });
    // stampGateState hands back the record UNCHANGED (not null) when the
    // verdict is already settled; a progress write that did not land is a
    // failure the runner should hear about, not a silent no-op.
    if (!wrote || wrote.gate_progress !== stamp) throw new Error("the run record could not be updated");
  };
  // The rescue lane's durable state (task-spor-factory-rescue-lane): one
  // entry per rescue attempt — the refusal it was handed, the seed its gate
  // pass starts from, its run and its diagnosis — on the same `gate_progress`
  // stamp, keyed to this attempt, so a killed worker resumes INSIDE the
  // rescue (adopting its run, or re-judging its pass) instead of re-running
  // the original pass and paging a person a rescue was about to spare.
  const loadRescueState = async () => {
    const r = readRecordNow();
    const all = r && r.gate_progress && typeof r.gate_progress === "object" ? r.gate_progress : null;
    if (!all || all.key !== runKey || !Array.isArray(all.rescue)) return [];
    return all.rescue.map((e) => {
      const out = { ...e };
      // A launch the rescue closure stamped before the worker died.
      if (out.n === r.gate_rescue_attempt && r.gate_rescue_run_id && !out.runId) {
        out.runId = r.gate_rescue_run_id;
        out.dispatched = true;
      }
      return out;
    });
  };
  const saveRescueState = async ({ rescues }) => {
    const r = readRecordNow();
    const prevAll = r && r.gate_progress && r.gate_progress.key === runKey ? r.gate_progress : null;
    const stamp = { key: runKey, at: new Date().toISOString(), seq: (prevAll && Number.isInteger(prevAll.seq) ? prevAll.seq : 0) + 1, gates: prevAll && prevAll.gates && typeof prevAll.gates === "object" ? prevAll.gates : {}, rescue: rescues };
    const wrote = dispatchRuns.stampGateState(home, entry.run_id, { gate_progress: stamp });
    if (!wrote || wrote.gate_progress !== stamp) throw new Error("the run record could not be updated");
  };

  // --- the rescue lane (task-spor-factory-rescue-lane, WORKERS.md §10.10) ---
  // Composed HERE, deterministically, like the review and the fix: the
  // strong-model profile is handed everything the run left behind — the work
  // item, the diff, the commit history of every fix cycle, the refused gate's
  // detail and evidence, the finding ledger, the gate facts already on the
  // graph, and any earlier rescue's diagnosis — and asked to diagnose, fix in
  // the same checkout, and file factory-improvement tasks. It is NOT asked to
  // pass anything: the runner re-runs the gates on whatever it commits. Its
  // structured diagnosis is read in code (gatesKernel.parseRescueReport) and
  // only feeds the escalation body and the rescue fact — fail-soft, so a
  // rescue that fixed the tree and forgot the block still gets its fix
  // judged. The dispatch runs under the RESCUE profile, so the worker's
  // ROUTING flags (--model/--agent) are dropped — the lane's profile is what
  // names the strong model — while its unattended POSTURE rides, filtered to
  // what the rescue's own harness accepts (rescuePassthrough).
  const rescue = async ({ gate, attempt, detail, evidence, findings, attempts, ledger, fact, facts = [], previous = [], onLaunch = null }) => {
    const lane = factory && factory.rescue;
    if (!lane || !lane.profile) return { ok: false, reason: "no rescue lane is declared on the factory" };
    const cwd = change ? change.cwd : (record && record.cwd) || undefined;
    if (!cwd) return { ok: false, reason: "the run's checkout is unknown, so the rescue has nowhere to work" };
    const item = await workItemText();
    const diff = change ? gateDiffText(change) : null;
    const history = change ? gateHistoryText(change) : "";
    const spent = gatesKernel.describeCycles(gate, attempts || []);
    const blocking = (findings || []).filter((f) => f.blocking !== false);
    const advisory = (findings || []).filter((f) => f.blocking === false);
    const name = `rescue-${short}-${attempt}`;
    // The harness-agnostic diagnosis channel (see gateRescueDiagnosis): the
    // file the prompt names, git-excluded in the checkout before the launch.
    const diagnosisFile = rescueDiagnosisPath(cwd, name);
    const prompt = [
      `You are the RESCUE lane of the '${factory.id || "factory"}' factory for Spor work item ${entry.node_id} (rescue attempt ${attempt} of ${lane.attempts}).`,
      `The '${gate.id}' ${gate.kind} gate refused this item and its fix cycles are spent (${spent.text}). Without you, a person`,
      "would be paged now. Your job, in order:",
      "",
      "1. DIAGNOSE what actually went wrong. Pick ONE category: `reviewer-drift` (the reviewer moved the goalposts or",
      "   demanded something the item never asked for), `real-defect` (the implementation is wrong and the gate is right),",
      "   `stale-premise` (the item's premise no longer holds — already done, wrong repo, superseded), or `environment`",
      "   (a red trusted ref, a flaky suite, a missing dependency, a harness problem — nothing about the change itself).",
      "2. FIX IT if a fix is the right answer: work in THIS checkout, commit with a clear message that names the finding",
      "   ids you addressed (the gates re-run on your commits and the next review is asked whether each prior finding is",
      "   resolved). Do NOT edit protected test paths — a change that touches them fails the gate closed. Leave the tree",
      "   CLEAN. If the premise is stale or the environment is at fault, say so and change nothing you cannot justify.",
      "   Verify in the FOREGROUND and read the exit before you commit — never background a suite and end your turn",
      "   waiting on it (see the session rule under \"Your report\").",
      "3. FILE what would have prevented this. Whether or not your fix lands, capture at least one Spor task proposing a",
      "   factory, gate, prompt or item change (a review instruction to tighten, a cycles cap to change, a suite to fix,",
      "   an item to re-scope) — `spor put-node - --if-exists skip` with a `type: task` node carrying",
      `   \`{type: derived-from, to: ${fact || "<the gate fact>"}}\` so /spor:factory's maintenance mode can read it, or \`spor add "..."\``,
      "   when you are unsure of the shape. Do not resolve, close or re-status the work item itself.",
      "",
      "You never mark a gate passed: the runner re-judges the whole gate list on the tree you leave.",
      "",
      "## The work item",
      "",
      item || `(the node ${entry.node_id} could not be read — judge the change against its commit messages)`,
      "",
      "## The refusal",
      "",
      `Gate \`${gate.id}\` (${gate.kind}): ${detail || "no detail"}`,
      ...(fact ? [`Gate fact on the graph: ${fact}${facts.length > 1 ? ` (all facts for this run: ${facts.join(", ")})` : ""}`] : []),
      "",
      ...((attempts || []).length > 1
        ? [`Cycles (${spent.text}):`, ...attempts.map((a, i) => `${i + 1}. ${i === 0 ? "initial review" : `after fix cycle ${i}`}: ${a.verdict} — ${String(a.detail || "").slice(0, 300)}`), ""]
        : []),
      ...(blocking.length ? ["Blocking findings still open:", gatesKernel.renderFindings(blocking), ""] : []),
      ...(advisory.length ? ["Advisory (recorded, not enforced):", gatesKernel.renderFindings(advisory), ""] : []),
      ...(ledger && ledger.length ? ["Finding ledger (every finding the gate's cycles raised, what cleared it, what still stands):", gatesKernel.renderLedger(ledger), ""] : []),
      ...(evidence ? ["Evidence:", "```", gateRunner.fenceSafe(String(evidence).slice(0, 4000)), "```", ""] : []),
      ...(previous.length
        ? [
            "## Earlier rescue attempts",
            "",
            ...previous.map((p) => `- attempt ${p.n}${p.runId ? ` (run ${String(p.runId).slice(0, 8)})` : ""}: ${p.error ? `could not run — ${p.error}` : `${p.category || "unknown"} — ${p.diagnosis || "(no diagnosis read)"}${(p.filed || []).length ? `; filed ${p.filed.join(", ")}` : ""}`}`),
            "",
            "Your diagnosis should say why the earlier rescue did not land, not repeat it.",
            "",
          ]
        : []),
      ...(change
        ? [
            "## The change",
            "",
            `\`git diff ${change.base}..${change.head}\` in ${cwd} (${Array.isArray(change.paths) ? change.paths.length : "?"} file(s)):`,
            "",
            "```diff",
            gateRunner.fenceSafe(diff.text),
            "```",
            ...(diff.truncated ? [`(diff truncated at ${Math.round(GATE_DIFF_CAP_BYTES / 1024)}KB — run the git command above for the rest)`] : []),
            "",
            ...(history ? ["## Every commit on the branch — the implementer's and each fix cycle's", "", "```", gateRunner.fenceSafe(history), "```", ""] : []),
          ]
        : [`## The change`, "", `The change under judgement could not be read from ${cwd}: ${detail || "see the refusal above"}. Start by reading the checkout's state (\`git status\`, \`git log\`).`, ""]),
      ...(lane.instructions ? ["## Factory instructions for the rescue", "", lane.instructions, ""] : []),
      "## Your report",
      "",
      "The fenced diagnosis block is MANDATORY. Write it the moment you have diagnosed — BEFORE any fix or long",
      "verification, so a session cut short still yields a category — and restate it at the end of your final message",
      "once `fixed` and `filed` are known (the runner reads the LAST block of your final message, and falls back to the",
      "last block of any earlier message — so the early block counts even if your final message never comes). Exactly this shape:",
      "",
      `ALSO write that same JSON object (the object alone, no fence needed) to \`${diagnosisFile}\` the moment you have`,
      "diagnosed, and rewrite it whenever `fixed` or `filed` change — the runner reads that file whenever your final",
      "message carries no block, whatever harness you run under. The file is git-excluded and untracked: it does not",
      "dirty the tree, and you must never `git add` or commit it.",
      "```json",
      `{"diagnosis": "what went wrong, in one or two sentences", "category": "reviewer-drift" | "real-defect" | "stale-premise" | "environment", "fixed": true | false, "filed": ["task-..."]}`,
      "```",
      "`fixed` is whether you committed a change you believe resolves the refusal; `filed` lists the Spor task ids you",
      "created. The runner reads this block for the escalation it files if the gates refuse again — it never decides a verdict.",
      "",
      workerContractLib.ONE_TURN_NOTICE,
    ].join("\n");
    // Adopted on resume exactly like a fix cycle: the launcher writes the run
    // record before dispatch returns, so a worker killed between the launch
    // and its durable record still finds the run by its unique name.
    const already = launchedFixRun(home, entry.node_id, name);
    // Read the lane's harness only when there is a launch to shape — an
    // adopted run was already launched under whatever posture it got.
    let values = null;
    if (!already) {
      const shaped = rescuePassthrough(passthrough, await rescueHarnessAdapter(cfg, lane.profile));
      if (shaped.dropped.length) {
        warn(
          `warning: the worker's ${shaped.dropped.map((d) => `--${d.flag}`).join(", ")} does not ride to the rescue under` +
            ` ${lane.profile} — ${shaped.dropped[0].message}`
        );
      }
      const appliedFlags = shaped.applied.map((a) => (a.value === true ? `--${a.flag}` : `--${a.flag} ${a.value}`)).join(" ");
      if (shaped.translated && shaped.translated.meaning === "read-only") {
        warn(
          `warning: the worker's posture (${shaped.translated.from}) reads as read-only, so the rescue under ${lane.profile} runs` +
            ` under that harness's own read-only posture (${appliedFlags}) — it can diagnose but not fix; a rescue never widens the worker's posture.`
        );
      } else if (shaped.translated && shaped.translated.meaning === "attended") {
        warn(
          shaped.translated.narrowed
            ? `warning: the worker's posture (${shaped.translated.from}) reads as attended, and ${lane.profile}'s harness has no attended posture` +
              ` (it never asks), so the rescue narrows to that harness's read-only posture (${appliedFlags}) — it can diagnose but not fix;` +
              ` a rescue never widens the worker's posture. Pass an unattended posture the worker means.`
            : shaped.applied.length
              ? `warning: the worker's posture (${shaped.translated.from}) reads as attended, so the rescue under ${lane.profile} runs attended` +
                ` there as ${appliedFlags} — the more restrictive of the two; it stops on its first unapproved write. Pass an unattended posture the worker means.`
              : `warning: the worker's posture (${shaped.translated.from}) reads as attended and has no ${lane.profile} spelling, so the rescue` +
                ` runs attended there — the more restrictive of the two; on claude-code it stalls on its first write. Pass an unattended posture the worker means.`
        );
      } else if (shaped.applied.length) {
        warn(
          (shaped.translated
            ? `warning: the worker's posture (${shaped.translated.from}) reads as unattended, so the rescue under ${lane.profile}`
            : `warning: the rescue under ${lane.profile} carries none of the worker's posture, so it`) +
            ` runs unattended with ${appliedFlags} — that harness stalls on its first write without it.`
        );
      }
      values = { ...shaped.values, profile: lane.profile, node: entry.node_id, dir: cwd, force: true, "no-worktree": true, name };
      // Fail-soft and silent: where the exclude cannot be written (not a git
      // checkout, an unwritable info/exclude) the gates' own untracked-residue
      // tolerance is the backstop.
      excludeRescueDiagnosisDir(cwd);
    }
    const launched = already ? { ok: true, run: already, adopted: true } : await dispatch(cfg, values, [prompt]);
    if (!launched.ok) return { ok: false, reason: `the rescue under ${lane.profile} could not be dispatched: ${launched.reason}` };
    if (launched.adopted) log(`work: rescue attempt ${attempt} on ${entry.node_id} was already launched as run ${String(launched.run.run_id).slice(0, 8)} — adopting it, not dispatching again`);
    dispatchRuns.stampGateState(home, entry.run_id, { gate_rescue_run_id: launched.run.run_id, gate_rescue_at: new Date().toISOString(), gate_rescue_attempt: attempt });
    if (onLaunch) {
      try {
        await onLaunch({ runId: launched.run.run_id });
      } catch (e) {
        warn(`warning: the rescue's launch could not be recorded on the run record (${(e && e.message) || e})`);
      }
    }
    const done = await awaitGateRun(cfg, launched.run.run_id, { timeoutMs: lane.awaitMs, warn, sleep });
    if (!done.ok) return { ok: false, reason: done.reason };
    const parsed = gateRescueDiagnosis(done.record, home, { file: diagnosisFile });
    if (parsed.salvaged === "file") log(`work: rescue attempt ${attempt} on ${entry.node_id} left no diagnosis block in its final report — read the one it wrote to ${diagnosisFile}`);
    else if (parsed.salvaged) log(`work: rescue attempt ${attempt} on ${entry.node_id} left no diagnosis block in its final report — read the last one from an earlier message on its stream`);
    if (!parsed.ok) log(`work: rescue attempt ${attempt} on ${entry.node_id} left no structured diagnosis (${parsed.error}) — its tree is judged regardless`);
    return { ok: true, runId: launched.run.run_id, diagnosis: parsed.diagnosis, category: parsed.category, fixed: parsed.fixed, filed: parsed.filed, unread: !parsed.ok, record: done.record };
  };

  return {
    now: () => Date.now(),
    sleep,
    // A worker asked to stop does not keep a human gate waiting: the pipeline
    // reports it BLOCKED (the approval item stands, unanswered) rather than
    // pretending to a verdict nobody gave.
    stopping,
    loadGateProgress,
    saveGateProgress,
    loadRescueState,
    saveRescueState,
    rescue,
    changedPaths: async ({ trustedRef }) => {
      change = null;
      const c = gateChangeSet(record, trustedRef);
      if (!c.ok) return c;
      change = c;
      return c;
    },
    // The two reads behind a SUPERSEDED verdict (issue-spor-work-adopts-
    // orphaned-pipeline-of-hand-landed-run): is the item resolved on the graph
    // — the same verify leg the loop's harvest uses — and is the run's head
    // already on the trusted ref. Consulted only for an adopted pipeline.
    resolved: async () => verifyRunResolution(cfg, record),
    landed: async ({ trustedRef }) => gateRunner.gateHeadLanded(record, trustedRef),
    // The judged tree is prepared ONCE per gate and handed back as a suite
    // handle: `run(attempt)` executes the declared command on it, `close()`
    // tears it down. The gate runner's rerun loop (WORKERS.md §10.3
    // `reruns`) calls `run` once per attempt on this ONE checkout — the
    // same worktree, the same forced protected paths, the same staged
    // dependencies — so a rerun is literally the same tree, not a fresh
    // build that happens to have the same sha, and the setup/teardown hooks
    // fire once for the whole loop rather than once per run.
    openSuite: async ({ gate, trustedRef, protectedPaths }) => {
      if (!change) return { ok: false, reason: "the change under judgement could not be read" };
      // The repo's own worktree-setup hook stages the throwaway tree exactly as
      // it stages an implementer's worktree (node_modules, a pinned sibling
      // checkout) — without it a repo whose suite needs anything not in git
      // fails its own gate on a missing dependency, never on the change.
      const tree = prepareGateTree(change, {
        trustedRef,
        protectedPaths,
        setup: (dir) => stageThrowawayTree(dir, change.top, { slug, nodeId: entry.node_id, what: "gate", role: "gate" }),
        teardown: (dir) => teardownThrowawayTree(dir, change.top, { slug, nodeId: entry.node_id, role: "gate", warn }),
      });
      if (!tree.ok) return tree;
      return {
        ok: true,
        dir: tree.dir,
        run: async (attempt = 1) => {
          // What the suite is judging, in its env (task-spor-gate-command-
          // change-env): a script can `git diff $SPOR_GATE_BASE..$SPOR_GATE_HEAD`
          // inside the tree and decide what to run, the way a CI job reads the
          // pull request's file list.
          const env = {
            ...worktreeDeclaredEnv(tree.dir),
            SPOR_GATE_STAGE: "gate",
            SPOR_GATE_BASE: change.base,
            SPOR_GATE_HEAD: change.head,
            SPOR_TRUSTED_REF: trustedRef,
            SPOR_GATE_NODE: entry.node_id || "",
            // 1 for the declared run, N+1 for the Nth same-tree rerun — a
            // suite can log or tighten itself on a rerun.
            SPOR_GATE_ATTEMPT: String(attempt),
          };
          return await runGateCommand(gate, tree.dir, { env });
        },
        // Called by the runner only after the LAST run has returned (its loop
        // awaits each run), never under a running suite.
        close: () => tree.cleanup(),
      };
    },
    // The per-gate serialize lease (task-spor-gate-serialize-lease) reuses the
    // integration stage's: keyed on the repo's MAIN checkout locally, the
    // synthetic per-repo lock node remotely, so a `serialize: repo` command
    // gate and the integration stage never overlap on one box either.
    acquireGateLease: () => acquireIntegrationLease(cfg, home, change ? change.top : record && record.cwd, { slug }),
    releaseGateLease: (token) => releaseIntegrationLease(cfg, token),
    review,
    fix,
    recordFact: ({ id, markdown }) => writeGateNode(cfg, id, markdown),
    fileTestLaneItem: async ({ gate, paths, profile, rescue = 0 }) => {
      const k = keysFor(rescue);
      const id = `task-test-lane-${stem}-${k.short}-${gateIdSuffix("test-lane", gate.id, entry.node_id, k.runKey)}`;
      const body = [
        `The implementer's branch for ${entry.node_id} changed protected test path(s):`,
        "",
        paths.slice(0, 50).map((p) => `- \`${p}\``).join("\n") + (paths.length > 50 ? `\n- …and ${paths.length - 50} more` : ""),
        "",
        `The \`${gate.id}\` command gate therefore failed CLOSED — the acceptance suite is never run from a`,
        "branch that edits it, because the same entity writing the test and the code under test carries the",
        "same misunderstanding into both (dec-spor-software-factory-substrate).",
        "",
        `Make the test change here instead, in the separate lane: run it under \`${profile}\`, e.g.`,
        "",
        `    spor dispatch ${id} --profile ${profile}`,
        "",
        `(or point a worker at the lane: \`spor work --profile ${profile}\`.) Once the test change lands on the`,
        `trusted ref, re-dispatch ${entry.node_id} and its gate runs against the new trusted suite.`,
      ].join("\n");
      return writeGateNode(
        cfg,
        id,
        buildGateWorkNode({
          id,
          title: `Test-change lane — ${entry.node_id} edited protected test paths`,
          summary: `The gated change for ${entry.node_id} touched ${paths.length} protected test path(s); the test change belongs in the ${profile} lane, not the implementer's branch.`,
          body,
          project: slug,
          date: date(),
          profile,
          // `blocks`, not `relates-to`: the gated item cannot legitimately
          // stand until the test change lands in its own lane, and that
          // dependency has to be readable by everyone, not just this box's
          // cooldown map.
          edges: [{ type: "blocks", to: entry.node_id }, ...(profile ? [{ type: "relates-to", to: profile }] : [])],
        })
      );
    },
    fileHumanItem: async ({ gate, classes, rescue = 0 }) => {
      const k = keysFor(rescue);
      const id = `task-approve-${gate.id.slice(0, 24)}-${stem}-${k.short}-${gateIdSuffix("approve", gate.id, entry.node_id, k.runKey)}`.toLowerCase();
      const body = [
        `The \`${gate.id}\` human gate is armed for ${entry.node_id}: the change touches` +
          (classes.length ? ` the declared risk class(es) ${classes.map((c) => `\`${c.class}\``).join(", ")}.` : " work this factory always has a person approve."),
        "",
        ...(classes.length
          ? classes.map((c) => `- \`${c.class}\`: ${c.paths.slice(0, 8).map((p) => `\`${p}\``).join(", ")}${c.paths.length > 8 ? ` (+${c.paths.length - 8} more)` : ""}`)
          : []),
        "",
        gate.instructions || "Review the change and decide whether it may stand.",
        "",
        `The worker is BLOCKED on this: ${entry.node_id} is not treated as done until this item is answered.`,
        `This item \`blocks\` ${entry.node_id} on the graph, and if that item had already been flipped to a`,
        "completion status the worker rolled it back — a gate records what was enforced, it never asserts",
        `completion, so approving here does not re-flip it. Close the loop on ${entry.node_id} yourself.`,
        "",
        "To APPROVE, resolve this item — capture the decision and point it here:",
        "",
        `    spor add "Approved the ${gate.id} gate on ${entry.node_id} — <why>"`,
        `    spor edge <the-new-node-id> resolves ${id}`,
        "",
        "To REFUSE:",
        "",
        `    spor set-status ${id} abandoned`,
      ].join("\n");
      return writeGateNode(
        cfg,
        id,
        buildGateWorkNode({
          id,
          title: `Approval — ${gate.id} gate on ${entry.node_id}`,
          summary: `A person must approve the ${gate.id} gate for ${entry.node_id}${classes.length ? ` (risk: ${classes.map((c) => c.class).join(", ")})` : ""}; the worker blocks its resolve until this is answered.`,
          body,
          project: slug,
          date: date(),
          requiresHuman: true,
          // `blocks`: an unanswered approval is not an approval, so the gated
          // item is not done — and that must be true on the graph, not only in
          // this worker's cooldown map.
          edges: [{ type: "blocks", to: entry.node_id }],
        })
      );
    },
    checkApproval: ({ id }) => gateApprovalState(cfg, id),
    demote: ({ blockerId }) => gateDemoteItem(cfg, entry.node_id, { blockerId }),
    escalate: async ({ gate, attempts, detail, evidence, findings, ledger, rescue = 0, rescues = [] }) => {
      const k = keysFor(rescue);
      const id = `task-gate-${gate.id.slice(0, 24)}-${stem}-${k.short}-${gateIdSuffix("escalate", gate.id, entry.node_id, k.runKey)}`.toLowerCase();
      const cycles = attempts.length;
      // Counted in FIX CYCLES against the cap, not in attempts: `attempts` has
      // one entry per review, so "4 attempts, cap 3" read as an off-by-one
      // when it was the initial review plus the three fix cycles declared.
      const spent = gatesKernel.describeCycles(gate, attempts);
      // The rescue lane ran first (task-spor-factory-rescue-lane): the body
      // OPENS with its diagnosis — the person is paged only because the
      // rescue also failed, and what it found is the first thing to read.
      const last = rescues.length ? rescues[rescues.length - 1] : null;
      const rescueLines = last
        ? [
            last.error
              ? `Rescue attempt ${last.n} could not run (${last.error}) — this is the refusal it was handed.`
              : `Rescue diagnosis (attempt ${last.n}${rescues.length > 1 ? ` of ${rescues.length}` : ""}, ${last.category || "unknown"}): ${last.diagnosis || "(the rescue left no readable diagnosis)"}`,
            ...(last.run_id ? [`The rescue ran as \`${last.run_id}\`${last.fixed ? " and committed a fix; the gates below refused the tree it left" : " and committed no fix it claims resolves the refusal"}.`] : []),
            ...((last.filed || []).length ? [`Filed by the rescue: ${last.filed.join(", ")}.`] : []),
            ...(rescues.length > 1
              ? rescues.slice(0, -1).map((r) => `Earlier rescue attempt ${r.n}: ${r.error ? `could not run (${r.error})` : `${r.category || "unknown"} — ${String(r.diagnosis || "").slice(0, 300)}`}`)
              : []),
            "",
          ]
        : [];
      const body = [
        ...rescueLines,
        `The \`${gate.kind}\` gate \`${gate.id}\` refused ${entry.node_id} and its fix cycles are spent`,
        `(${spent.text})${rescue ? `, after rescue attempt ${rescue}` : ""}. A person decides what happens next —`,
        "the worker has stopped re-dispatching it.",
        "",
        `This item \`blocks\` ${entry.node_id} on the graph, and if that item had already been flipped to a`,
        "completion status the worker rolled it back. The run's resolver is left standing: it is the record of",
        "what the agent did, and retiring it (or letting it stand) is the judgement this item is asking for.",
        "",
        detail ? `Last outcome: ${detail}` : "",
        "",
        ...(findings && findings.length ? ["Findings:", "", gatesKernel.renderFindings(findings), ""] : []),
        ...(ledger && ledger.length ? ["Finding ledger:", "", gatesKernel.renderLedger(ledger), ""] : []),
        ...(evidence ? ["Evidence:", "", "```", fenceSafe(String(evidence).slice(0, 3000)), "```", ""] : []),
        ...(cycles > 1
          ? [`Cycles (${spent.text}):`, ...attempts.map((a, i) => `${i + 1}. ${i === 0 ? "initial review" : `after fix cycle ${i}`}: ${a.verdict} — ${String(a.detail || "").slice(0, 200)}`), ""]
          : []),
        `The run's own record is \`${entry.run_id}\` ('spor runs ${entry.run_id}').`,
      ]
        .filter((l) => l !== "")
        .join("\n");
      return writeGateNode(
        cfg,
        id,
        buildGateWorkNode({
          id,
          title: `Gate escalation — ${gate.id} refused ${entry.node_id}${rescue ? " after rescue" : ""}`,
          summary: last
            ? `Rescue ${last.error ? "could not run" : `diagnosed ${last.category || "unknown"}`}: ${String(last.error || last.diagnosis || "no diagnosis").slice(0, 200)} — the ${gate.id} ${gate.kind} gate still refused ${entry.node_id}; it needs a person.`
            : `The ${gate.id} ${gate.kind} gate refused ${entry.node_id} after ${spent.fixes} fix cycle(s); it needs a person${detail ? `: ${String(detail).slice(0, 200)}` : "."}`,
          body,
          project: slug,
          date: date(),
          requiresHuman: true,
          // `blocks`: the escalation is what the gated item now waits on, and
          // the graph has to say so — a refusal that lives only in one box's
          // cooldown map leaves every other reader calling the item done.
          edges: [{ type: "blocks", to: entry.node_id }],
        })
      );
    },
    log,
  };
}

// --- the integration stage's serialize:repo lease (dec-spor-factory-
// integration-step) ------------------------------------------------------
// The declared lease scope is one repo: N workers on M machines should not all
// build a candidate against the same target ref at once. Correctness never
// rests on this — git's own compare-and-swap (update-ref / a push's non-fast-
// forward rejection) is what makes a LOST race safe regardless (the decision's
// own framing: "makes the CAS race rare rather than load-bearing") — so every
// failure here is FAIL-OPEN: an unavailable lease logs a note and the stage
// proceeds without one, exactly like every other best-effort dep in this file.
//
// Remote mode reuses the SAME server-held claim/lease dispatch uses
// (claimDispatch, above), against a synthetic per-repo lock node minted the
// first time it is needed. Local mode has no lease pool at all (dec-cc-task-
// claim-lease "Local mode"), so it falls back to a machine-local lockfile
// scoped to the repo's own path — the one thing this lease can still
// coordinate offline: two `spor work` loops on the SAME box.
const INTEGRATION_LEASE_STALE_MS = 30 * 60 * 1000; // older than any real integration pass could legitimately run
const INTEGRATION_LEASE_WAIT_MS = 20000; // how long to wait for a busy lease before proceeding without one
const INTEGRATION_LEASE_POLL_MS = 1000;

function integrationLeaseKey(top) {
  // The repo's durable MAIN checkout, never the per-item worktree `top`
  // usually names (gateChangeSet's `--show-toplevel` of a dispatch worktree
  // IS the worktree): two workers landing two items have two worktrees, and a
  // lease keyed on those would never have serialized anything.
  const anchor = mainCheckoutOf(top) || top;
  return crypto.createHash("sha256").update(path.resolve(anchor || "")).digest("hex").slice(0, 16);
}

async function acquireLocalIntegrationLease(home, top, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const dir = path.join(home, "journal", "integration-lease");
  const file = path.join(dir, `${integrationLeaseKey(top)}.lock`);
  const deadline = Date.now() + INTEGRATION_LEASE_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started_ticks: dispatchRuns.processStartTicks(process.pid), at: new Date().toISOString() }), { flag: "wx" });
      return { kind: "lockfile", file };
    } catch (e) {
      if (e.code !== "EEXIST") return null; // an unwritable journal is not worth blocking integration over
    }
    let stale = false;
    try {
      const held = JSON.parse(fs.readFileSync(file, "utf8"));
      const age = Date.now() - (Date.parse(held.at || "") || 0);
      stale = age > INTEGRATION_LEASE_STALE_MS || !workerAlive(held.pid, held.started_ticks);
    } catch {
      stale = true; // an unreadable lock file cannot be honored as a live one
    }
    if (stale) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* a concurrent racer may have already cleared it */
      }
      continue;
    }
    if (Date.now() >= deadline) return null;
    await sleep(INTEGRATION_LEASE_POLL_MS);
  }
}

function releaseLocalIntegrationLease(token) {
  if (!token || token.kind !== "lockfile") return;
  try {
    fs.rmSync(token.file, { force: true });
  } catch {
    /* it lapses on its own next stale check */
  }
}

async function acquireIntegrationLease(cfg, home, top, { slug } = {}) {
  if (cfg.mode() !== "remote") return acquireLocalIntegrationLease(home, top);
  const id = `lock-integration-${gateStem(slug || path.basename(top || "repo"))}`;
  const markdown = [
    "---",
    `id: ${id}`,
    "type: artifact",
    `title: Integration lease — ${id}`,
    "summary: The serialize:repo lease the integration stage holds while landing a candidate onto its target ref.",
    "---",
    "",
    "Coordination node only — carries no durable fact of its own.",
    "",
  ].join("\n");
  try {
    await writeGateNode(cfg, id, markdown);
    const claimed = await claimDispatch(cfg, id, null, `integration-${crypto.randomUUID()}`);
    if (claimed.ok) return { kind: "remote", id };
    return null; // held by another worker, or the claim door errored — proceed without the lease
  } catch {
    return null;
  }
}

async function releaseIntegrationLease(cfg, token) {
  if (!token) return;
  if (token.kind === "remote") {
    try {
      await remote.post(cfg, `/v1/nodes/${encodeURIComponent(token.id)}/release`, {}, { timeoutMs: 6000 });
    } catch {
      /* lapses on its own TTL */
    }
    return;
  }
  releaseLocalIntegrationLease(token);
}

// task-spor-integration-propose-mode: the `gh` CLI is the v1 backend for
// opening pull requests — a declared capability the machine must satisfy,
// refused loudly rather than substituted (the same rule a declared harness a
// machine cannot run already gets). `cmdWork` checks this once at startup
// (loud and early); `proposeIntegrationPR` checks it again per call so a
// direct caller of makeIntegrationDeps (a test, a future entry point) gets
// the same refusal rather than a raw ENOENT.
function runGh(args, opts = {}) {
  return spawnPortableSync("gh", args, { encoding: "utf8", timeout: 20000, ...opts });
}

// The github.com `owner/repo` slug `gh --repo` needs, read from the `origin`
// remote — the same remote the candidate build's push-mode landing already
// assumes (splitRemoteRef's default). Null for anything that is not a
// github.com URL (ssh or https): `gh` only ever targets github.com, so a
// non-GitHub remote cannot open a PR through it regardless of what strategy
// the graph declares.
function ghRepoSlug(top) {
  const url = (git(top, ["remote", "get-url", "origin"]).stdout || "").trim();
  const m = url.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Open (or update) the PR that carries `head` onto `targetRef`, from the
// implementer's OWN branch — never the throwaway candidate merge commit,
// which only ever proved merging would be green. Idempotent across a fix
// cycle: a re-run pushes the branch's new tip and reuses whatever PR is
// already open for it rather than erroring on a duplicate.
function proposeIntegrationPR({ top, head, targetRef }) {
  if (!hasCmd("gh")) return { ok: false, reason: "the 'gh' CLI is not on PATH — propose mode needs it to open pull requests" };
  const repo = ghRepoSlug(top);
  if (!repo) return { ok: false, reason: `could not resolve a github.com 'owner/repo' from ${top}'s 'origin' remote — propose mode needs a GitHub remote` };
  const { remote: remoteName, branch: baseBranch } = integrationRunner.splitRemoteRef(targetRef);
  const branchName = (git(top, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "").trim();
  if (!branchName || branchName === "HEAD") return { ok: false, reason: `could not read the branch name to propose from — ${top} is in detached HEAD` };

  const push = git(top, ["push", "-u", remoteName, `${head}:refs/heads/${branchName}`]);
  if (push.status !== 0) {
    return { ok: false, reason: (push.stderr || "").trim().split("\n").filter(Boolean).pop() || "git push failed" };
  }

  // Reuse keys on the (head, base) PAIR, never branch name alone
  // (task-spor-integration-propose-mode base-check gap): a same-named branch
  // can carry an open PR to a DIFFERENT base — a stale proposal left over
  // from a prior targetRef, or someone else's PR against the same branch
  // name. Adopting that one would hand checkProposal a PR whose merge (if it
  // ever happens) never reaches THIS run's actual targetRef. `gh pr list
  // --base` already filters server-side to the exact pair; the `baseRefName`
  // equality check below is defense in depth against a `gh` version or test
  // fixture that doesn't filter. A same-head PR to a different base is left
  // untouched (not closed, not superseded — it is someone else's PR) and a
  // fresh PR is opened against targetRef instead; GitHub allows one PR per
  // (head, base) pair, so this never collides with the ignored PR.
  const existing = runGh(
    ["pr", "list", "--repo", repo, "--head", branchName, "--base", baseBranch, "--state", "open", "--json", "number,url,state,baseRefName"],
    { cwd: top }
  );
  if (existing.status === 0 && existing.stdout) {
    try {
      const list = JSON.parse(existing.stdout);
      const j = Array.isArray(list) ? list[0] : null;
      if (j && j.number && String(j.state || "").toUpperCase() === "OPEN" && j.baseRefName === baseBranch) {
        return { ok: true, number: j.number, url: j.url, repo, branch: branchName, targetRef, detail: `PR #${j.number} already open (${j.url}) — updated with ${head.slice(0, 8)}` };
      }
    } catch {
      /* unparseable is not evidence a PR exists — fall through to create one */
    }
  }

  const create = runGh(
    [
      "pr", "create", "--repo", repo, "--base", baseBranch, "--head", branchName,
      "--title", `Integration: ${branchName}`,
      "--body", `Opened by the spor work integration stage (\`propose\` mode) for \`${branchName}\` onto \`${baseBranch}\`.`,
    ],
    { cwd: top }
  );
  if (create.status !== 0) {
    return { ok: false, reason: (create.stderr || create.stdout || "").trim().split("\n").filter(Boolean).pop() || "gh pr create failed" };
  }
  const url = (create.stdout || "").trim().split("\n").filter(Boolean).pop() || "";
  const num = (url.match(/\/pull\/(\d+)/) || [])[1];
  if (!num) return { ok: false, reason: `gh pr create did not report a pull request number/url (got: ${url || "nothing"})` };
  return { ok: true, number: Number(num), url, repo, branch: branchName, targetRef, detail: `opened PR #${num} (${url}) for ${head.slice(0, 8)} onto ${targetRef}` };
}

// The PR's current state, for checkProposals below — {ok, state: "open" |
// "closed", merged, mergeCommitSha, mergedBy, baseRefName} | {ok:false,
// reason}. GitHub's own three-way state (OPEN/CLOSED/MERGED) collapses to a
// boolean here: a merge IS a closure, and `checkProposal` (integration-
// runner.js) only ever asks "still open, or closed — and if closed, how".
// `baseRefName` is reported unconditionally (not just when merged) so
// checkProposal can cross-check it against the proposal's own targetRef
// before ever treating a merge as landing there — GitHub's merged/closed
// report is keyed by PR NUMBER alone and says nothing about which base it
// actually merged onto (task-spor-integration-propose-mode base-check gap).
function ghPrStatus({ repo, number }) {
  if (!hasCmd("gh")) return { ok: false, reason: "the 'gh' CLI is not on PATH" };
  if (!repo || !number) return { ok: false, reason: "no pull request repo/number recorded for this proposal" };
  const r = runGh(["pr", "view", String(number), "--repo", repo, "--json", "state,mergedAt,mergeCommit,mergedBy,baseRefName"]);
  if (r.status !== 0) return { ok: false, reason: (r.stderr || r.stdout || "gh pr view failed").trim().split("\n").filter(Boolean).pop() || "gh pr view failed" };
  let j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    return { ok: false, reason: "gh pr view returned unparseable JSON" };
  }
  const state = String((j && j.state) || "").toUpperCase();
  const baseRefName = (j && j.baseRefName) || null;
  if (state === "OPEN") return { ok: true, state: "open", baseRefName };
  if (state === "MERGED") {
    return {
      ok: true,
      state: "closed",
      merged: true,
      mergeCommitSha: (j.mergeCommit && j.mergeCommit.oid) || null,
      mergedBy: (j.mergedBy && j.mergedBy.login) || null,
      baseRefName,
    };
  }
  return { ok: true, state: "closed", merged: false, baseRefName };
}

// The deterministic id of the tracking item park() files for a propose-mode
// proposal — pulled out so it can be RECOMPUTED from a run record alone
// (node_id/run_id are the only inputs), which is what lets checkProposals
// heal one whose original tracking-node write never landed
// (issue-spor-integration-park-orphan) without needing the id to have been
// stamped successfully in the first place.
function proposalTrackingId(nodeId, runId) {
  return `task-integration-proposed-${gateStem(nodeId)}-${gateShortRun(runId)}-${gateIdSuffix("integration-park", "integration", nodeId, runId)}`.toLowerCase();
}

// The tracking item's own content — extracted so parkForReview's first write
// attempt and checkProposals' healing path (below) build BYTE-IDENTICAL
// markdown for the same inputs. writeGateNode's same-id dedup rule treats any
// content difference as a real collision, not a safe idempotent retry, so the
// two call sites must never drift apart.
function buildProposalTrackingNode({ id, nodeId, runId, targetRef, proposal, project, date }) {
  const body = [
    `The integration stage opened a pull request for ${nodeId} instead of landing it directly — this`,
    `factory declares \`propose\` mode, which never mutates \`${targetRef}\` itself.`,
    "",
    `Pull request: ${proposal.url || (proposal.number ? `#${proposal.number}` : "(unknown)")}`,
    "",
    "No worker will re-dispatch this item while this tracking item is open, and none will poll it either —",
    "the next 'spor work' pass on this box checks the pull request itself and, once it lands, writes the",
    "landed fact, resolves this item, and restores the work item's own resolution automatically. Nothing",
    "further is needed here beyond reviewing and merging the pull request on GitHub.",
    "",
    `The run's own record is \`${runId}\` ('spor runs ${runId}').`,
  ].join("\n");
  return buildGateWorkNode({
    id,
    title: `Integration proposed — PR pending review for ${nodeId}`,
    summary: `The integration stage opened ${proposal.url || `PR #${proposal.number}`} for ${nodeId}; it lands automatically once the PR merges.`,
    body,
    project,
    date,
    requiresHuman: true,
    edges: [{ type: "blocks", to: nodeId }],
  });
}

// The deps one integration stage runs on — the shell half of
// integration-runner.js's pure orchestration, mirroring makeGateDeps above.
// Only ever constructed when `factory.integration` resolved, so a bare
// factory (or one with no integration block) never touches any of this.
function makeIntegrationDeps(cfg, { record, entry, factory, slug, passthrough, warn, sleep, log, runMaxMs = workLoop.WORK_DEFAULTS.runMaxMs, dispatch = dispatchThrough, home = cfg.userConfigHome() }) {
  const integration = factory.integration;
  const date = () => new Date().toISOString().slice(0, 10);
  const stem = gateStem(entry.node_id);
  const short = gateRunner.shortRunAttempt(entry.run_id, entry.attempt);
  const runKey = gateRunner.gateRunKey(entry.run_id, entry.attempt);
  let top = null;

  const fix = async ({ cycle, kind, detail, evidence }) => {
    const why =
      kind === "conflict"
        ? `the integration stage could not merge your branch onto \`${integration.targetRef}\` — it conflicts.`
        : kind === "suite"
        ? `the integration stage's candidate suite (\`${integration.command}\`) failed on the merged tree.`
        : kind === "propose"
        ? `the integration stage could not open a pull request for your change onto \`${integration.targetRef}\`.`
        : `the integration stage could not land your change onto \`${integration.targetRef}\`.`;
    const prompt = [
      `The integration stage refused to land ${entry.node_id} onto \`${integration.targetRef}\` (\`${integration.mode}\` mode, \`${integration.strategy}\` strategy).`,
      "",
      why,
      "",
      detail || "",
      "",
      evidence ? `Evidence:\n${String(evidence).slice(0, 4000)}` : "",
      "",
      kind === "conflict"
        ? `Merge or rebase onto the current \`${integration.targetRef}\` yourself in this checkout, resolve the conflict, and commit.`
        : "Fix the cause in this checkout and commit.",
      "The stage will rebuild the candidate and re-run the full suite, so do not edit protected test paths — a change",
      "that touches them fails the acceptance gate closed, separately from this stage.",
      workerContractLib.ONE_TURN_NOTICE,
    ]
      .filter((l) => l !== "")
      .join("\n");
    const fixName = `integration-fix-${short}-${cycle}`;
    // Adopt a fix this stage already launched at this cycle (see the gate
    // deps' fix closure) rather than dispatching it twice.
    const already = launchedFixRun(home, entry.node_id, fixName);
    const launched = already ? { ok: true, run: already, adopted: true } : await dispatch(cfg, { ...passthrough, node: entry.node_id, dir: record ? record.cwd : undefined, force: true, "no-worktree": true, name: fixName }, [prompt]);
    if (!launched.ok) return { ok: false, reason: launched.reason };
    if (launched.adopted) log(`work: integration fix cycle ${cycle} on ${entry.node_id} was already launched as run ${String(launched.run.run_id).slice(0, 8)} — adopting it, not dispatching again`);
    dispatchRuns.stampGateState(home, entry.run_id, { gate_fix_run_id: launched.run.run_id, gate_fix_at: new Date().toISOString(), gate_fix_gate: "integration", gate_fix_cycle: cycle });
    const done = await awaitGateRun(cfg, launched.run.run_id, { timeoutMs: runMaxMs, warn, sleep });
    if (!done.ok) return { ok: false, reason: done.reason };
    return { ok: true, runId: launched.run.run_id, record: done.record };
  };

  return {
    now: () => Date.now(),
    changedTree: async () => {
      const c = gateRunner.gateChangeSet(record, integration.targetRef);
      if (c.ok) top = c.top;
      return c;
    },
    acquireLease: () => acquireIntegrationLease(cfg, home, top || (record && record.cwd), { slug }),
    releaseLease: (token) => releaseIntegrationLease(cfg, token),
    buildCandidate: async ({ head, targetRef, strategy, mode }) => {
      const built = integrationRunner.buildCandidateTree({
        top, head, targetRef, strategy, mode, label: entry.node_id,
        teardown: (dir) => teardownThrowawayTree(dir, top, { slug, nodeId: entry.node_id, role: "integration", warn }),
      });
      if (!built.ok) return built;
      // Same staging the command gate's tree gets (stageThrowawayTree): the
      // candidate suite runs here, and a repo whose suite needs a hook-staged
      // dependency must not fail its own landing on a bare checkout.
      const staged = stageThrowawayTree(built.dir, top, { slug, nodeId: entry.node_id, what: "integration candidate", role: "integration" });
      if (!staged.ok) {
        built.cleanup();
        return { ok: false, reason: staged.reason };
      }
      return built;
    },
    forceProtected: ({ dir, sha }) => {
      const forced = gateRunner.forceProtectedPaths({ top, dir, trustedRef: factory.trustedRef, protectedPaths: factory.protectedPaths });
      if (!forced.ok) return forced;
      // The restore above only touches the candidate worktree's WORKING
      // DIRECTORY — `sha` still names the pre-restoration commit. Landing it
      // as-is would ship the tampered protected-path edits the restore is
      // meant to strip (issue-spor-integration-landed-sha-pre-restoration), so
      // re-commit when the restore actually changed anything and land that
      // sha instead; a no-op restore returns `sha` unchanged.
      return integrationRunner.reconcileCandidateSha({ dir, sha });
    },
    runSuite: ({ dir, base, head, attempt = 1 }) =>
      gateRunner.runGateCommand({ id: "integration", command: integration.command, timeoutMs: integration.timeoutMs }, dir, {
        env: {
          ...worktreeDeclaredEnv(dir),
          SPOR_GATE_STAGE: "integration",
          SPOR_GATE_BASE: base || "",
          SPOR_GATE_HEAD: head || "",
          SPOR_TRUSTED_REF: factory.trustedRef,
          SPOR_GATE_NODE: entry.node_id || "",
          SPOR_GATE_ATTEMPT: String(attempt),
        },
      }),
    land: (args) => integrationRunner.landCandidate(args),
    propose: ({ head, targetRef }) => proposeIntegrationPR({ top, head, targetRef }),
    parkForReview: async ({ proposal }) => {
      const id = proposalTrackingId(entry.node_id, entry.run_id);
      const written = await writeGateNode(
        cfg,
        id,
        buildProposalTrackingNode({ id, nodeId: entry.node_id, runId: entry.run_id, targetRef: integration.targetRef, proposal, project: slug, date: date() })
      );
      // Stamped BEFORE gate_state becomes "parked" (the caller writes that
      // right after this pipeline settles) — a proposal's own open/landed/
      // closed lifecycle can never live in a stamp AFTER settlement
      // (stampGateState refuses to touch a record whose gate_state already
      // reads a SETTLED_GATE_STATES value), so every field checkProposals
      // needs later is captured here, in the one window before it does.
      //
      // Stamped UNCONDITIONALLY — not gated on `written.ok`
      // (issue-spor-integration-park-orphan). The pull request already exists
      // by the time this runs (deps.propose already opened it), so
      // gate_proposal_number is the durable fact "there is a PR to check",
      // and it must never become unreachable just because the tracking-node
      // write above hit a transient failure. `id` is deterministic
      // (proposalTrackingId), so checkProposals can always find/recompute it
      // and heal a tracking item that never actually landed on the graph.
      dispatchRuns.stampGateState(home, entry.run_id, {
        gate_proposal_number: proposal.number || null,
        gate_proposal_repo: proposal.repo || null,
        gate_proposal_url: proposal.url || null,
        gate_proposal_branch: proposal.branch || null,
        gate_proposal_target_ref: integration.targetRef,
        gate_proposal_strategy: integration.strategy,
        gate_proposal_blocker: id,
        gate_proposal_project: slug || null,
        gate_proposal_factory: factory.id || null,
      });
      return { ...written, id };
    },
    fix,
    recordFact: ({ id, markdown }) => writeGateNode(cfg, id, markdown),
    cleanupImplementer: async () => {
      const dir = record && record.cwd;
      if (!dir) return;
      const common = (git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout || "").trim();
      const repoDir = common ? path.dirname(common) : null;
      if (!repoDir || path.resolve(repoDir) === path.resolve(dir)) return; // the main checkout, not a dispatch worktree — nothing to remove
      removeDispatchWorktree(repoDir, dir, path.basename(dir));
    },
    demote: ({ blockerId }) => gateDemoteItem(cfg, entry.node_id, { blockerId }),
    escalate: async ({ attempts, detail, evidence }) => {
      const id = `task-integration-${stem}-${short}-${gateIdSuffix("integration-escalate", "integration", entry.node_id, runKey)}`.toLowerCase();
      // A lost CAS race is nobody's fix cycle (integration-runner.js never
      // charges it against the cap), so it must not be counted as one here —
      // an escalation reading "5 attempts, cap 0" after 5 races and zero real
      // fixes would mislead whoever triages it about what actually happened.
      const raced = attempts.filter((a) => a.verdict === "race").length;
      const cycles = attempts.length - raced;
      const why = cycles
        ? `its fix cycles are spent (${cycles} attempt${cycles === 1 ? "" : "s"}, cap ${integration.cycles})`
        : `it lost the landing race ${raced} time${raced === 1 ? "" : "s"} in a row`;
      const body = [
        `The integration stage could not land ${entry.node_id} onto \`${integration.targetRef}\` — ${why}. A person`,
        "decides what happens next — the worker has stopped retrying it.",
        "",
        `This item \`blocks\` ${entry.node_id} on the graph, and if that item had already been flipped to a`,
        "completion status the worker rolled it back. Every declared gate already passed; only the merge-queue",
        "landing itself is unresolved. The run's resolver is left standing.",
        "",
        detail ? `Last outcome: ${detail}` : "",
        "",
        ...(evidence ? ["Evidence:", "", "```", fenceSafe(String(evidence).slice(0, 3000)), "```", ""] : []),
        ...(attempts.length > 1 ? ["Attempts:", ...attempts.map((a, i) => `${i + 1}. ${a.verdict} — ${String(a.detail || "").slice(0, 200)}`), ""] : []),
        `The run's own record is \`${entry.run_id}\` ('spor runs ${entry.run_id}').`,
      ]
        .filter((l) => l !== "")
        .join("\n");
      return writeGateNode(
        cfg,
        id,
        buildGateWorkNode({
          id,
          title: `Integration escalation — could not land ${entry.node_id}`,
          summary: `The integration stage could not land ${entry.node_id} onto ${integration.targetRef} after ${attempts.length} attempt(s); it needs a person${detail ? `: ${String(detail).slice(0, 200)}` : "."}`,
          body,
          project: slug,
          date: date(),
          requiresHuman: true,
          edges: [{ type: "blocks", to: entry.node_id }],
        })
      );
    },
    log,
  };
}

// Run the gate pipeline and, if every declared gate passed and the factory
// declares an integration block, follow it with the integration stage — the
// two folded into ONE promise so work-loop.js's slot-holding, cooldown, and
// resume machinery (which all key on `deps.gate`'s single settled verdict)
// need no changes at all (dec-spor-factory-integration-step: "the run HOLDS
// ITS SLOT through integration"). With no integration declared, this returns
// the gate pipeline's own result untouched — byte-identical to before this
// stage existed.
async function runGateAndIntegration(cfg, entry, record, ctx) {
  // The item's OWN repo stamp when the slot carried one, falling back to the
  // worker's scope token. Under a multi-repo factory those differ, and an
  // `art-gate-*`/`art-merge-*` fact filed under the wrong repo is mis-filed in
  // every project-scoped surface there is (review finding 4).
  const item = { ...entry, project: entry.project || ctx.slug || null };
  // ...and the deps inherit it as their `slug`, so the ESCALATION, the test-lane
  // item, the approval item, the proposal tracker and its `gate_proposal_project`
  // are all filed under the item's repo as well. Filing the fail-closed half of
  // a refusal (§10.7) under the worker's scope token would hide it from exactly
  // the project-scoped queue a person would look in.
  const dctx = { ...ctx, slug: item.project || ctx.slug || null, record, entry };
  const gateResult = await gateRunner.runGatePipeline({ item, factory: ctx.factory, log: ctx.log, deps: makeGateDeps(cfg, dctx) });
  if (gateResult.state !== "passed" || !ctx.factory.integration) return gateResult;
  const intResult = await integrationRunner.runIntegrationStage({ item, factory: ctx.factory, log: ctx.log, deps: makeIntegrationDeps(cfg, dctx) });
  return { ...intResult, gates: gateResult.gates, facts: [...(gateResult.facts || []), ...(intResult.facts || [])] };
}

// task-spor-integration-propose-mode: the LATER half of propose mode's
// lifecycle, run once per 'spor work' pass (never inside the run that opened
// the PR — that run already parked and freed its slot; see runIntegrationStage's
// `park()`). Scans this box's own run journal for parked proposals — the
// `gate_proposal_*` fields parkForReview stamped, keyed off `gate_state:
// "parked"` — and checks each pull request via `gh`.
//
// A proposal whose tracking item is no longer pending (approved by a landed
// fact this box, another pass, or another machine sharing this graph already
// wrote — or rejected by a person who intervened) is someone else's settled
// outcome and is skipped without spending a `gh` call: gateApprovalState reads
// the graph, which is the one place two machines checking the same PR agree.
// Whether the tracking item park() filed has already reached a terminal
// status — checked directly on the STATUS FIELD, deliberately NOT via
// gateApprovalState's resolving-edge read. checkProposal writes the landed
// fact (which carries the `resolves` edge onto this item) BEFORE calling
// `restore` — task-cc-terminal-status-requires-resolver means the resolver
// has to exist before the item's own status can validly flip terminal — so a
// live resolving edge can exist for a beat (or, if `restore` then fails,
// indefinitely) before the item is genuinely closed. Reading that edge as
// "settled" would let a failed restore attempt never retry: the work item's
// completion status would stay rolled back forever with nothing left to
// re-check. An unreadable node is not evidence of closure either — a graph
// blip must not stop checkProposals from trying again next pass.
async function blockerAlreadyClosed(cfg, id) {
  const node = await resolveNode(cfg, id);
  if (!node) return false;
  const status = String(node.status || "").trim().toLowerCase();
  if (!status) return false;
  if (cfg.mode() !== "remote") {
    try {
      const { graph: g } = u.loadGraphCached(cfg.nodesDir());
      return isTerminalStatus(status, node.type, g);
    } catch {
      return false;
    }
  }
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  return graphLib.isTerminalStatusOffline(status, node.type || null);
}

// checkProposal's `restore` dep, real: promotes the work item's own status
// back, then closes the tracking item — extracted to a NAMED function (rather
// than an inline closure) so this exact retry-convergence behavior is
// directly testable, not only reachable through a real `gh` call.
//
// Closes the tracking item whenever the work item's own status could be
// EVALUATED (`promoted.ok`), not only when THIS call was the one that
// actually flipped it — `restored: false` with `ok: true` means "already at
// the completion value" (a previous pass promoted it but then failed to
// close the tracking item, e.g. a transient write failure), which is still
// success, not nothing-to-do: skipping the close in that case is exactly
// what would strand the tracking item open forever, since a later pass's
// blockerAlreadyClosed check (below) would keep finding it non-terminal and
// keep retrying — this is what actually makes those retries converge.
async function restoreProposal(cfg, { blockerId, nodeId }) {
  const promoted = await gatePromoteItem(cfg, nodeId);
  if (!promoted.ok) return promoted;
  const closed = await gateWriteStatus(cfg, blockerId, "done");
  if (!closed.ok) return { ok: true, restored: promoted.restored, note: `${promoted.note}; ${blockerId} could not be closed (${closed.reason})` };
  return promoted;
}

// issue-spor-integration-park-orphan: parkForReview stamps gate_proposal_*
// unconditionally once a PR opens (makeIntegrationDeps above), independent of
// whether the tracking-node write itself landed — so a transient failure
// there must not permanently orphan an already-opened PR. This is the healing
// half: recreate the tracking item, byte-for-byte identical to what
// parkForReview would have written (buildProposalTrackingNode is the SAME
// builder both call), if it is not already sitting on the graph. Only
// attempts the write when the node is confirmed ABSENT — never when it
// merely reads differently than a freshly-built "just opened" node would
// (e.g. it already progressed to `status: done` via restore()) — a
// same-id-different-content write in that case would be a real collision,
// not a heal, and writeGateNode would (correctly) refuse it.
async function healProposalTracking(cfg, r) {
  const id = r.gate_proposal_blocker || proposalTrackingId(r.node_id, r.run_id);
  const existing = await resolveNode(cfg, id);
  if (existing) return { id, healed: false, ok: true };
  const proposal = { number: r.gate_proposal_number, url: r.gate_proposal_url };
  const markdown = buildProposalTrackingNode({
    id,
    nodeId: r.node_id,
    runId: r.run_id,
    targetRef: r.gate_proposal_target_ref,
    proposal,
    project: r.gate_proposal_project || null,
    date: new Date().toISOString().slice(0, 10),
  });
  const written = await writeGateNode(cfg, id, markdown);
  return { id, healed: !!(written && written.ok), ok: !!(written && written.ok), reason: written && written.reason };
}

// Whether a proposal settled between a pass's tracker read and the demotion
// that read licensed (checkProposals, F4): its tracker now reads terminal, or
// its LANDED fact — the deterministic id checkProposal mints for a merged PR,
// written by the settling actor's pass BEFORE it promotes the item and closes
// the tracker — is on the graph. Either is evidence the item's completion
// stands again and a rollback that just landed on it must be undone. An
// unreadable graph is evidence of neither (the demotion then stands, as the
// tracker read that licensed it said it should).
async function proposalSettledMeanwhile(cfg, r, blockerId) {
  try {
    if (await blockerAlreadyClosed(cfg, blockerId)) return true;
  } catch {
    /* not evidence */
  }
  try {
    const landedFact = integrationRunner.integrationFactId(r.node_id, r.run_id, "landed");
    return !!(await resolveNode(cfg, landedFact));
  } catch {
    return false;
  }
}

async function checkProposals(cfg, { home = cfg.userConfigHome(), log = () => {} } = {}) {
  // Requires only gate_proposal_number — NOT gate_proposal_blocker too — so a
  // proposal whose tracking-node write failed (leaving the blocker field
  // stamped but the node itself missing, or on an older run record from
  // before both fields were stamped together) is still discovered rather than
  // silently skipped forever.
  const records = dispatchRuns.readRunRecords(home).filter((r) => r.gate_state === "parked" && r.gate_proposal_number);
  for (const r of records) {
    const healed = await healProposalTracking(cfg, r);
    if (!healed.ok) {
      log(`work: the integration proposal tracking item for ${r.node_id} could not be healed (${healed.reason || "no response"}) — will retry next pass`);
      continue; // no tracking item to check/demote against yet — try again next pass
    }
    // A tracker that had to be HEALED is one park() never had in hand, so
    // park() withheld the item's demotion (the §10.7 pair is atomic:
    // escalate/track first, demote only with the blocker's id). Complete it
    // now, one pass late — the same fail-soft, idempotent door park() would
    // have used, so a record from before the pair was atomic (already rolled
    // back) reads "nothing to roll back" here rather than failing.
    //
    // `gate_demote_pending` is the durable form of "the rollback has not
    // landed": stamped by the loop when park() reported a demotion that
    // FAILED (a transient write error beside a tracker that did file), and
    // here when the heal-pass demotion fails the same way. Without it a
    // demotion that failed once was never retried — the next pass found the
    // tracker present, healed nothing, and left the item at its completion
    // status for as long as the proposal stayed open. The stamp is cleared
    // the moment a demotion lands, so a settled record costs no extra read.
    //
    // The tracker's own status is read FIRST (F3 of the same review): a
    // tracker that is already terminal — closed by restore() once the PR
    // merged, or by a person — means the proposal is SETTLED, and a
    // demotion owed from an earlier pass is no longer owed. Retrying it here
    // would roll a completed item back to `open` behind a blocker that is
    // no longer live, and the settled check below would then skip every
    // restoration — the item stuck open with nothing left to close it.
    //
    // That read is NOT atomic with the demotion (F4 of the same review): the
    // graph has no compare-and-swap on a status write, so between the read
    // and the rollback another actor — a second box's proposal pass whose
    // restore() promoted the item and closed the tracker, or a person — can
    // settle the proposal, and the rollback then lands on a COMPLETED item
    // behind a tracker no longer live, with the flag cleared and (the tracker
    // now reading closed) every later pass skipping it. So a demotion that
    // actually flipped the item is followed by a SECOND read of the same
    // settled evidence (`proposalSettledMeanwhile`: the tracker terminal, or
    // the landed fact — which the other actor's restore writes FIRST —
    // present), and one that lands against a proposal settled meanwhile is
    // undone on the spot by the same promotion restore() uses. Undoing it
    // can fail too, so the debt is durable: `gate_restore_pending` on the run
    // record, retried at the top of every pass until it lands.
    // Every flag write below is checked (F5 of the same review): stampGateState
    // is best-effort and returns null when the record could not be written,
    // and a debt the record does not carry is a debt no later pass can see.
    // A stamp that fails therefore leaves the PREVIOUS flags standing — which
    // is why the debts are written in ONE stamp each (never "clear this,
    // then owe that" as two writes, a window a crash or a failed second write
    // turns into a stranded item), and why a stale `gate_demote_pending`
    // against a settled proposal is treated as "the rollback MAY have landed"
    // (recovered, below) rather than as a no-op to clear.
    const stamp = (patch, what) => {
      const wrote = dispatchRuns.stampGateState(home, r.run_id, patch, { force: true });
      if (!wrote) log(`work: the run record for ${r.node_id} could not be stamped (${what}) — the debt it carried stands and is re-examined next pass`);
      return !!wrote;
    };
    if (r.gate_restore_pending) {
      let promoted = null;
      try {
        promoted = await gatePromoteItem(cfg, r.node_id);
      } catch (e) {
        promoted = { ok: false, reason: `${(e && e.message) || e}` };
      }
      if (promoted && promoted.ok) {
        log(`work: undid the demotion of ${r.node_id} that landed against an already-settled proposal; ${promoted.note}`);
        stamp({ gate_restore_pending: false }, "the owed undo landed");
      } else {
        log(`work: the demotion of ${r.node_id} that landed against an already-settled proposal could not be undone (${(promoted && promoted.reason) || "no response"}) — will retry next pass`);
      }
    }
    let closed = false;
    try {
      closed = await blockerAlreadyClosed(cfg, healed.id);
    } catch {
      closed = false; // an unreadable graph is not evidence this is settled
    }
    if (closed) {
      if (r.gate_demote_pending) {
        // A pending flag against a closed tracker is not only "never owed":
        // it is also what a pass whose stamp never landed leaves behind AFTER
        // its rollback did land (F5) — the item demoted, the proposal settled
        // meanwhile, the undo unrecorded. If the proposal LANDED (its landed
        // fact is on the graph — the settling pass writes it before it
        // promotes), the item's completion must stand, so restore it here
        // (idempotent: an item already at its completion reads "nothing to
        // restore") and clear the flag only once that holds. A tracker a
        // person closed with no landing is left alone, as before.
        let landedFactPresent = false;
        try {
          landedFactPresent = !!(await resolveNode(cfg, integrationRunner.integrationFactId(r.node_id, r.run_id, "landed")));
        } catch {
          landedFactPresent = false;
        }
        let restored = { ok: true, note: null };
        if (landedFactPresent) {
          try {
            restored = await gatePromoteItem(cfg, r.node_id);
          } catch (e) {
            restored = { ok: false, reason: `${(e && e.message) || e}` };
          }
        }
        if (restored && restored.ok) {
          log(`work: the tracking item ${healed.id} for ${r.node_id} is already closed — the withheld demotion is no longer owed${restored.note ? `; ${restored.note}` : ""}`);
          stamp({ gate_demote_pending: false }, "the withheld demotion is no longer owed");
        } else {
          log(`work: the tracking item ${healed.id} for ${r.node_id} is already closed and its proposal landed, but the item could not be restored (${(restored && restored.reason) || "no response"}) — will retry next pass`);
        }
      }
      continue;
    }
    // The record is not the only ledger of the debt (F1 of the third
    // review): a heal-pass demotion that fails AND whose `gate_demote_pending`
    // stamp fails leaves NOTHING behind — the next pass finds the tracker
    // present (healed nothing) and no flag, and skips the demotion for the
    // life of the open PR. So when neither the heal nor the flag says a
    // rollback is owed, the pass RE-DERIVES it from the graph, where the debt
    // is always legible: an OPEN tracker (read above) whose proposal has not
    // landed (no landed fact) beside an item still at its completion status
    // IS a withheld rollback, whatever the record says. gateDemoteItem is
    // the probe — it reads the item and rolls back only a claim of
    // completion, answering "nothing to roll back" otherwise — so the common
    // case (item already `open`) is one read and no write, and an item that
    // really was stranded is demoted through exactly the path a flagged
    // retry takes (settled-meanwhile check and undo included). A probe needs
    // no flag of its own: it runs again next pass, so a probe that fails is
    // only logged. The landed fact is checked first because restore() writes
    // it before it promotes and closes the tracker — a tracker whose close
    // failed sits open beside a legitimately completed item, and a probe
    // that demoted it there would churn against the landing every pass. And
    // the read must distinguish ABSENT from UNREADABLE (F2): resolveNode
    // answers null to a 5xx, a timeout or an EACCES exactly as it does to a
    // missing node, so a probe keyed on it would demote a legitimately landed
    // item on a server blip. Only a confirmed absence (404 / ENOENT) licenses
    // the probe; an unreadable graph is "unknown", and unknown is not-absent —
    // the probe simply runs again next pass.
    const owed = !!(healed.healed || r.gate_demote_pending);
    let probe = false;
    if (!owed) {
      try {
        probe = await nodeConfirmedAbsent(cfg, integrationRunner.integrationFactId(r.node_id, r.run_id, "landed"));
      } catch {
        probe = false; // an unreadable graph cannot license a rollback
      }
    }
    if (owed || probe) {
      let demoted = null;
      try {
        demoted = await gateDemoteItem(cfg, r.node_id, { blockerId: healed.id });
      } catch (e) {
        demoted = { ok: false, reason: `${(e && e.message) || e}` };
      }
      const landed = !!(demoted && demoted.ok);
      if (probe && landed && !demoted.demoted) {
        // The ordinary case: nothing was owed. Silent — this is a read, not
        // a retry, and the item's proposal is checked below as before.
      } else {
        const how = healed.healed
          ? `healed the tracking item for ${r.node_id}`
          : probe
            ? `recovered an unrecorded rollback debt for ${r.node_id} (its tracking item ${healed.id} is open, its proposal has not landed, and it still claimed completion)`
            : `retried the withheld demotion of ${r.node_id}`;
        if (landed) log(`work: ${how}; ${demoted.note}`);
        else if (probe) log(`work: ${r.node_id} could not be read to check whether its rollback is still owed (${(demoted && demoted.reason) || "no response"}) — will check again next pass`);
        else log(`work: ${how}, but it could not be demoted on the graph (${(demoted && demoted.reason) || "no response"}) — the proposal still stands; will retry next pass`);
      }
      // The check-then-demote window (F4, above): only a rollback that
      // actually FLIPPED the item can have crossed it — a no-op demotion
      // ("nothing to roll back") changed nothing to undo. The settled check
      // and the undo run BEFORE any flag is written, so the record moves in
      // one stamp from "demotion owed" to exactly what is owed now — the undo
      // (`gate_restore_pending`), or nothing. `parked` is a settled state, so
      // the stamp forces past stampGateState's settled guard: it touches no
      // verdict, only the flags that say what is still owed.
      if (landed && demoted.demoted && (await proposalSettledMeanwhile(cfg, r, healed.id))) {
        let promoted = null;
        try {
          promoted = await gatePromoteItem(cfg, r.node_id);
        } catch (e) {
          promoted = { ok: false, reason: `${(e && e.message) || e}` };
        }
        const undone = !!(promoted && promoted.ok);
        if (undone) log(`work: the proposal for ${r.node_id} settled while its demotion was landing — undone; ${promoted.note}`);
        else log(`work: the proposal for ${r.node_id} settled while its demotion was landing, and undoing it failed (${(promoted && promoted.reason) || "no response"}) — will retry next pass`);
        stamp({ gate_demote_pending: false, gate_restore_pending: !undone }, undone ? "the rollback and its undo both landed" : "the undo is owed");
        continue; // settled: nothing left for this pass to check
      }
      // A probe that found nothing (or could not read) owes no stamp: the
      // record carries no flag and the graph is re-read next pass. One that
      // flipped the item, or a flagged/healed attempt, writes its outcome.
      if (!probe || (landed && demoted.demoted)) stamp({ gate_demote_pending: !landed }, landed ? "the rollback landed" : "the rollback is owed");
    }
    const proposal = {
      nodeId: r.node_id,
      runId: r.run_id,
      project: r.gate_proposal_project || null,
      number: r.gate_proposal_number,
      repo: r.gate_proposal_repo,
      url: r.gate_proposal_url,
      branch: r.gate_proposal_branch,
      targetRef: r.gate_proposal_target_ref,
      strategy: r.gate_proposal_strategy,
      blockerId: healed.id,
      factory: r.gate_proposal_factory,
    };
    try {
      await integrationRunner.checkProposal(proposal, {
        deps: {
          prStatus: (p) => ghPrStatus(p),
          recordFact: ({ id, markdown }) => writeGateNode(cfg, id, markdown),
          restore: (args) => restoreProposal(cfg, args),
        },
        log,
      });
    } catch (e) {
      log(`work: checking the proposal for ${r.node_id} failed (${(e && e.message) || e})`);
    }
  }
}

// --- `spor work --regate <run-id>` (task-spor-work-regate) ---------------
// Re-judge ONE refused run under the factory, without redoing the work. A gate
// can refuse for a reason that is not the item's: the trusted ref itself is
// red (a sibling-lib drift, someone else's landing), the suite flaked under
// contention, a reviewer harness was down. The pipeline's fail-closed shape
// then leaves the item demoted, blocked by a `requires: [human]` escalation,
// with its resolver standing and its work sitting committed in a worktree —
// and no path back but a person re-doing the item from scratch. This is that
// path: the person fixes the cause, then re-runs the same gates on the same
// run. The facts it mints carry the attempt in their ids (gate-runner.js
// gateRunKey), so the first verdict's record is never overwritten or refused
// as a collision; on a PASS it closes the escalation the last attempt filed
// (with a resolving artifact) and restores the completion status that attempt
// rolled back — the two graph-state halves of a refusal (WORKERS.md §10.7),
// undone by the same machinery that wrote them.
async function cmdWorkRegate(cfg, values, { factory, factoryId, slug, passthrough, warn, runMaxMs, home }) {
  if (!factory) {
    err("spor work --regate needs a factory — pass --factory <id> or set work.factory; a re-gate re-runs the factory's own gates.");
    return 1;
  }
  const wanted = String(values.regate || "").trim();
  const matches = wanted ? dispatchRuns.listRuns(home, { runId: wanted }) : [];
  if (!matches.length) {
    err(`spor work --regate: no run record matches '${wanted || "(empty)"}' ('spor runs' lists this box's runs).`);
    return 1;
  }
  if (matches.length > 1) {
    err(`spor work --regate: '${wanted}' matches ${matches.length} runs — pass more of the id.`);
    return 1;
  }
  const record = matches[0];
  const shortId = String(record.run_id).slice(0, 8);
  if (!dispatchRuns.TERMINAL_STATES.has(record.state)) {
    err(`spor work --regate: run ${shortId} is still '${record.state}' — a gate judges a finished run ('spor runs ${shortId}' follows it).`);
    return 1;
  }
  if (!record.node_id) {
    err(`spor work --regate: run ${shortId} was a free-text dispatch with no work item — there is nothing to gate.`);
    return 1;
  }
  if (!workLoop.shouldGate(record)) {
    err(
      `spor work --regate: run ${shortId} ended '${record.terminal_state || record.state}'${record.terminal_enforced ? " (enforced)" : ""} — ` +
        "it carries no claim of completion to judge (only a resolved run, or an unenforced reported one, is gated; a declined run never is)."
    );
    return 1;
  }
  if (record.gate_state === "passed" || record.gate_state === "parked" || record.gate_state === "superseded") {
    err(`spor work --regate: run ${shortId} already read '${record.gate_state}'${record.gate_reason ? ` (${record.gate_reason})` : ""} — there is nothing to re-judge.`);
    return 1;
  }
  if (record.gate_state === "running" && record.gate_worker) {
    const live = workLoop.readWorkerStatuses(home, { alive: workerAlive }).some((w) => w.live && w.worker_id === record.gate_worker);
    if (live) {
      err(`spor work --regate: run ${shortId} is being gated right now by worker ${String(record.gate_worker).slice(0, 8)} — wait for its verdict.`);
      return 1;
    }
  }
  // Attempt 1 was the pipeline that refused; each re-gate counts up from there.
  const attempt = (Number(record.gate_regate_count) || 0) + 2;
  // The item's OWN repo stamp, exactly as the loop's slot would carry it.
  let project = slug || null;
  try {
    const node = await resolveNode(cfg, record.node_id);
    if (node && (node.repo || node.project)) project = node.repo || node.project;
  } catch {
    /* the worker's scope token stands in */
  }
  // Bring the implementer's branch up to the trusted ref BEFORE judging it
  // (issue-spor-command-gate-judges-stale-branch-base): the usual reason a
  // run is re-gated is that the trusted ref was red and has since been fixed,
  // and a command gate judges the branch's OWN base — so without this the
  // re-gate re-tests the same stale tree and fails the same way. A merge
  // conflict is refused loudly (the branch needs a person or a fix cycle);
  // a dirty tree is left alone and refused by the gate as before.
  const refreshed = refreshBranchFromTrustedRef(record.cwd, factory.trustedRef);
  if (refreshed.refused) {
    err(`spor work --regate: ${refreshed.refused}`);
    return 1;
  }
  if (refreshed.note) out(`work: ${refreshed.note}`);
  const previous = record.gate_state ? `${record.gate_state}${record.gate_reason ? `: ${record.gate_reason}` : ""}` : "no recorded verdict";
  // Every escalation this run has accumulated across attempts — a passing
  // re-gate answers all of them, not only the latest.
  const escalatedBefore = [...new Set([...(Array.isArray(record.gate_escalation_ids) ? record.gate_escalation_ids : []), record.gate_escalated_to].filter(Boolean))];
  out(`work: re-gating ${record.node_id} — run ${shortId}, attempt ${attempt}, under ${factoryId} (previously ${previous})`);
  const stamp = (patch) => dispatchRuns.stampGateState(home, record.run_id, patch, { force: true });
  stamp({ gate_state: "running", gate_at: new Date().toISOString(), gate_worker: null, gate_regate_count: attempt - 1, gate_regated_at: new Date().toISOString() });
  const entry = { run_id: record.run_id, node_id: record.node_id, harness: record.harness || null, project, attempt };
  let res;
  try {
    res = await runGateAndIntegration(cfg, entry, record, {
      factory, slug, passthrough, warn, runMaxMs,
      log: (line) => out(line),
      stopping: () => false,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  } catch (e) {
    res = { state: "failed", reason: `the gate pipeline threw: ${(e && e.message) || e}` };
  }
  const state = (res && res.state) || "failed";
  const reason = res && res.reason ? String(res.reason).slice(0, 300) : null;
  stamp({
    gate_state: state,
    gate_reason: reason,
    ...(res && res.escalated_to ? { gate_escalated_to: res.escalated_to, gate_escalation_ids: [...escalatedBefore, res.escalated_to] } : {}),
    // Whether THIS attempt could file its escalation (task-spor-gate-escalation-
    // demote-atomic). Written either way, unlike the sticky `gate_demoted`
    // above: a demotion outlives the attempt that made it, but "nothing about
    // this refusal reached the graph" is answered afresh by every attempt, and
    // a re-gate that escalated (or passed) must not leave the old claim standing.
    gate_escalation_failed: !!(res && res.escalation_failed),
    // A demotion from an earlier attempt still stands until a pass restores it.
    ...(res && res.demoted ? { gate_demoted: true } : {}),
    // A park whose tracker filed but whose demotion failed owes the rollback
    // to checkProposals (§10.9); the same flag the loop stamps.
    ...(state === "parked" && res && res.escalated_to && res.demote_reason ? { gate_demote_pending: true } : {}),
  });
  if (state !== "passed") {
    out(`work: re-gate of ${record.node_id} ${state}${reason ? ` — ${reason}` : ""}${res && res.escalated_to ? ` (escalated to ${res.escalated_to})` : ""}`);
    return 1;
  }
  // The refusal's graph state, undone: the escalation it filed is answered by
  // a record of this pass, and the completion status it rolled back comes back.
  const notes = [];
  if (escalatedBefore.length) {
    const closed = await writeRegateArtifact(cfg, { record, entry, factoryId, previous, reason, escalatedTo: escalatedBefore, project });
    notes.push(closed.ok ? `closed ${escalatedBefore.join(", ")} with ${closed.id}` : `could not close ${escalatedBefore.join(", ")} (${closed.reason}) — resolve by hand`);
  }
  if (record.gate_demoted) {
    const promoted = await gatePromoteItem(cfg, record.node_id);
    notes.push(promoted.ok ? promoted.note : `could not restore ${record.node_id}'s status (${promoted.reason})`);
  }
  out(`work: re-gate of ${record.node_id} passed — ${reason || "every gate passed"}${notes.length ? `; ${notes.join("; ")}` : ""}`);
  return 0;
}

// Merge the trusted ref into the run's checkout ahead of a re-gate. Returns
// {note} (what happened, for the log), {} (nothing to do — no checkout, not a
// git tree, dirty, or already up to date), or {refused} (a conflict).
function refreshBranchFromTrustedRef(cwd, trustedRef) {
  if (!cwd || !fs.existsSync(cwd)) return {};
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).status !== 0) return {};
  const dirty = git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.status !== 0 || (dirty.stdout || "").trim()) return {}; // the gate refuses a dirty tree itself, with the better message
  const target = git(cwd, ["rev-parse", "--verify", "--quiet", trustedRef]);
  if (target.status !== 0) return {};
  if (git(cwd, ["merge-base", "--is-ancestor", trustedRef, "HEAD"]).status === 0) return {};
  const before = (git(cwd, ["rev-parse", "HEAD"]).stdout || "").trim();
  const merge = git(cwd, ["-c", "user.name=spor-regate", "-c", "user.email=regate@spor.local", "merge", "--no-edit", "-m", `Merge ${trustedRef} into the branch before re-gating`, trustedRef]);
  if (merge.status !== 0) {
    git(cwd, ["merge", "--abort"]);
    const line = `${merge.stdout || ""}\n${merge.stderr || ""}`.trim().split("\n").filter(Boolean).pop() || "git merge failed";
    return { refused: `merging ${trustedRef} into ${cwd} conflicts (${line}) — resolve it in that checkout (or re-dispatch the item), then re-gate` };
  }
  const after = (git(cwd, ["rev-parse", "HEAD"]).stdout || "").trim();
  return { note: `merged ${trustedRef} (${(target.stdout || "").trim().slice(0, 8)}) into ${cwd} before re-gating (${before.slice(0, 8)} -> ${after.slice(0, 8)})` };
}

// The resolving record a passing re-gate writes onto the escalation the
// refused attempt filed — an artifact, through the same validated door as
// every other gate node, idempotent by id.
async function writeRegateArtifact(cfg, { record, entry, factoryId, previous, reason, escalatedTo, project }) {
  const stem = gateStem(entry.node_id);
  const short = gateRunner.shortRunAttempt(entry.run_id, entry.attempt);
  const id = `art-regate-${stem}-${short}-${gateIdSuffix("regate", factoryId || "factory", entry.node_id, gateRunner.gateRunKey(entry.run_id, entry.attempt))}`.toLowerCase();
  const flat = (t, cap) => {
    const s = String(t || "").replace(/\s+/g, " ").trim();
    return s.length > cap ? `${s.slice(0, cap - 1)}…` : s;
  };
  const lines = [
    "---",
    `id: ${id}`,
    "type: artifact",
    ...(project ? [`project: ${project}`] : []),
    `title: Re-gate passed — ${flat(entry.node_id, 60)} (attempt ${entry.attempt})`,
    `summary: ${flat(`Run ${String(entry.run_id).slice(0, 8)} on ${entry.node_id} was re-judged under ${factoryId} after its earlier refusal (${previous}) and passed every gate: ${reason || "every gate passed"}. This closes the ${escalatedTo.length === 1 ? "escalation" : `${escalatedTo.length} escalations`} the refusals filed.`, 460)}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
    "edges:",
    ...escalatedTo.map((id) => `  - {type: resolves, to: ${id}}`),
    `  - {type: relates-to, to: ${entry.node_id}}`,
    "---",
    "",
    `\`spor work --regate ${entry.run_id}\` re-ran factory \`${factoryId}\`'s gates on the same run — the same committed`,
    `work, judged again after the cause of the earlier refusal was fixed outside the item. Previous verdict: ${flat(previous, 300)}.`,
    "",
    `Outcome: ${flat(reason || "every gate passed", 300)}`,
    "",
    "This is a gate outcome, not a resolution of the work item: the item's own resolver already stands, and the",
    "escalation this resolves was the refusal's blocker, now answered.",
    "",
  ];
  const written = await writeGateNode(cfg, id, gateCapBytes(lines.join("\n"), NODE_BODY_CAP_BYTES - 512));
  return { ...written, id };
}

// The code a worker RUNS is the code it loaded at startup — a long-running
// `spor work` keeps executing the lib/bin it required, however far the
// checkout it was loaded from moves afterwards (worker 3edbecd2 ran from 15:50
// on code predating the fix that had landed on main hours earlier, so the fix
// never applied to its pipelines — issue-spor-rescue-and-fix-sessions-end-turn-
// waiting-on-background-job, task-spor-work-announce-lib-commit-and-notice-
// main-moved). `loadedCodeCommit` names that code: the checkout's HEAD when
// the package root is a SOURCE checkout (a developer's clone, a worktree, a
// monorepo package), null when it is not (an npm install — the package
// version stands in). "Is a git checkout" is NOT `git rev-parse` succeeding:
// git walks UP from any directory, so an npm-installed copy under a
// consumer's `node_modules/` answers with the CONSUMER's commit and the
// worker would announce, and watch, code it never loaded
// (issue-spor-rescue-and-fix-sessions-end-turn-waiting-on-background-job,
// F4). A source checkout is one whose own `package.json` git TRACKS from
// that root (an install's is ignored or untracked, and a subdirectory of a
// checkout — `lib/` — has none), and that is not itself under a
// `node_modules` segment (a vendored copy is still an install). Fail-soft
// and bounded: a few short `git` calls per call, never a throw.
function loadedCodeCommit(root = ROOT) {
  try {
    if (path.resolve(root).split(path.sep).includes("node_modules")) return null;
    const tracked = codeGit(root, ["ls-files", "--error-unmatch", "--", "package.json"]);
    if (tracked == null || !tracked.trim()) return null;
    const commit = (codeGit(root, ["rev-parse", "--short", "HEAD"]) || "").trim();
    if (!commit) return null;
    const branch = (codeGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]) || "").trim();
    return { commit, branch: branch && branch !== "HEAD" ? branch : null };
  } catch {
    return null;
  }
}

// Every git read the probe and the notice make goes through the env-scrubbed
// `gitSpawn` (lib/shell/git-exec.js, dec-spor-dispatch-git-location-env-scrub)
// like the rest of the CLI: git takes its repository from an ambient
// GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR before it discovers one from `cwd`, so
// a bare spawn under a leaked variable would announce — and, under
// `--restart-on-land`, drain on — a DIFFERENT repository's commit (review
// finding F2 on task-spor-work-announce-lib-commit-and-notice-main-moved).
// Bounded (3s) and fail-soft: stdout on exit 0, null otherwise.
function codeGit(root, args) {
  const r = gitSpawn(root, args, { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? String(r.stdout || "") : null;
}

// Which ref the notice below WATCHES — "main moved past the loaded code" is a
// statement about a ref, not about whatever HEAD happens to be: a linked
// worker checkout switching branches, a `git checkout <older>` to bisect, or
// a rewound HEAD all change HEAD without anything having landed (review
// finding F1). Preference: the factory's declared integration target (the
// ref its own pipelines land onto — a self-hosting factory's `target_ref`),
// when it resolves to a commit in the code checkout; else the branch the
// code was loaded from; else (a detached HEAD, nothing declared) HEAD itself.
// null when there is no source checkout to watch.
function codeWatchRef(loaded, { root = ROOT, targetRef = null } = {}) {
  if (!loaded) return null;
  const candidates = [targetRef, loaded.branch].map((r) => String(r || "").trim()).filter(Boolean);
  for (const ref of candidates) {
    if (codeGit(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]) != null) return ref;
  }
  return "HEAD";
}

// The per-pass notice for the above: when the watched ref has moved PAST the
// commit the worker loaded — its tip is a different commit that DESCENDS from
// the loaded one (`merge-base --is-ancestor`), i.e. something landed on top of
// the loaded code — say so ONCE per new tip; the worker still runs what it
// loaded, and the operator's remedy is a restart. A tip that does not descend
// from the loaded commit (a branch switch, a bisect checkout, a rewind, an
// unrelated history) is not a land and says nothing — and, under
// `--restart-on-land`, does not drain the worker. A checkout that is not a git
// checkout, or a ref that has not moved, says nothing (byte-identical to
// before the notice existed). Returns the new tip on the pass that says so,
// undefined otherwise.
function makeCodeMovedNotice(loaded, { root = ROOT, log = () => {}, ref = null } = {}) {
  let noticed = loaded ? loaded.commit : null;
  const watch = ref || codeWatchRef(loaded, { root });
  return () => {
    if (!loaded || !watch) return;
    const now = (codeGit(root, ["rev-parse", "--short", `${watch}^{commit}`]) || "").trim();
    if (!now || now === noticed || now === loaded.commit) return;
    // Abbreviations grow as a repo does, so compare the OBJECTS: a longer
    // spelling of the loaded commit is not a move.
    const full = (r) => (codeGit(root, ["rev-parse", "--verify", "-q", `${r}^{commit}`]) || "").trim();
    if (full(now) && full(now) === full(loaded.commit)) return;
    // Only a DEFINITIVE ancestry answer settles this tip: exit 0 (descends)
    // or exit 1 (does not). Anything else — a timeout, a spawn error, git's
    // 128 on a momentarily unreadable object store mid-fetch — leaves the
    // tip UNRECORDED so the next pass asks again; recording it first would
    // turn one transient failure into a permanently silenced notice, and a
    // never-draining `--restart-on-land`, for that tip (review finding F3).
    // The record is a closure variable, not durable state: there is no
    // write that can fail to land, no second flag to owe, and no other actor
    // reading it.
    const anc = gitSpawn(root, ["merge-base", "--is-ancestor", loaded.commit, now], { timeout: 3000, stdio: "ignore" });
    if (anc.error || (anc.status !== 0 && anc.status !== 1)) return;
    // Remember the tip either way, so an unrelated tip is examined once and a
    // later descendant tip is still noticed.
    noticed = now;
    if (anc.status !== 0) return;
    log(`work: ${watch} in ${root} moved to ${now} — this worker still runs the code it loaded at ${loaded.commit}; restart it to pick the new code up`);
    // The tip moved past, for a caller that acts on it (`--restart-on-land`);
    // every other return above is undefined, so a caller that ignores it
    // sees nothing new.
    return now;
  };
}

async function cmdWork(cfg, { values }) {
  if (values.status) return cmdWorkStatus(cfg, { json: !!values.json });

  // Scope: an explicit --project, else the queue.project pin the rest of the
  // read surface already honors, else the whole queue — a worker box is not
  // inherently single-repo, and each item is dispatched into ITS own repo
  // through the slug->path map. A factory can narrow the DEFAULT below, but
  // the scope token never bounds what a gate may judge: the factory's own
  // declared repo scope does (issue-spor-work-scope-union-factory-mismatch).
  const explicitSlug = values.project || cfg.get("work.project", null) || cfg.get("queue.project", null) || null;
  let slug = explicitSlug;
  // Numeric options are REJECTED, not silently replaced, when they aren't a
  // number in range: an unattended `spor work --max $N` with a typo'd $N would
  // otherwise quietly become an unbounded worker, and an explicit
  // `--retry-after 0` would quietly become ten minutes. `bad` collects the
  // problems so one run reports all of them.
  const bad = [];
  // The ceiling is not decoration: these become setTimeout delays, and Node
  // CLAMPS anything over 2**31-1 ms to 1ms — so `--interval 3000000` (an easy
  // slip when the config key beside it, work.intervalMs, is in MILLISECONDS)
  // would turn a monthly poll into a thousand-per-second spin. The config
  // fallback goes through the same range, since it reaches setTimeout by the
  // same route.
  const num = (flag, raw, { min, max, fallback }) => {
    const clamp = (v) => Math.min(max, Math.max(min, v));
    const safeFallback = Number.isFinite(Number(fallback)) ? clamp(Number(fallback)) : min;
    if (raw == null) return safeFallback;
    const v = String(raw).trim() === "" ? NaN : Number(raw);
    if (!Number.isFinite(v) || v < min || v > max) {
      bad.push(`--${flag} ${raw === "" ? "(empty)" : raw} — expected a number between ${min} and ${max}`);
      return safeFallback;
    }
    return v;
  };
  const DAY_S = 86400;
  const concurrency = num("concurrency", values.concurrency, { min: 1, max: 1000, fallback: cfg.getNum("work.concurrency", workLoop.WORK_DEFAULTS.concurrency) });
  const intervalMs = num("interval", values.interval, { min: 1, max: DAY_S, fallback: cfg.getNum("work.intervalMs", workLoop.WORK_DEFAULTS.intervalMs) / 1000 }) * 1000;
  const maxIntervalMs = num("max-interval", values["max-interval"], { min: 1, max: DAY_S, fallback: cfg.getNum("work.maxIntervalMs", workLoop.WORK_DEFAULTS.maxIntervalMs) / 1000 }) * 1000;
  const retryAfterMs = num("retry-after", values["retry-after"], { min: 0, max: 30 * DAY_S, fallback: cfg.getNum("work.retryAfterMs", workLoop.WORK_DEFAULTS.retryAfterMs) / 1000 }) * 1000;
  const runMaxMs = num("run-max", values["run-max"], { min: 0, max: 720, fallback: cfg.getNum("work.runMaxMs", workLoop.WORK_DEFAULTS.runMaxMs) / 3600000 }) * 3600000;
  const runIdleMs = num("run-idle", values["run-idle"], { min: 0, max: 43200, fallback: cfg.getNum("work.runIdleMs", workLoop.WORK_DEFAULTS.runIdleMs) / 60000 }) * 60000;
  const max = num("max", values.max, { min: 0, max: 1000000, fallback: 0 });
  // `--restart-on-land` (work.restartOnLand): exit cleanly, once the in-flight
  // work settles, when the checkout this worker loaded its code from moves past
  // that code — for a self-hosting factory whose worker sits on the checkout
  // its own pipelines land onto, run under a supervisor that restarts it. Opt-in
  // only; the flag wins over the config key.
  const restartOnLand = values["restart-on-land"] ? true : cfg.getBool("work.restartOnLand", false);
  // The acceptance policy (task-spor-work-accept-policy): which readiness
  // classifications this loop may pick up. `ready` (the default) dispatches
  // only items a person explicitly stamped agent-ready; `open` restores the
  // original looser pickup (everything except readiness:human — that floor is
  // WORKERS.md §3's and no policy value moves it). Resolution: --accept >
  // SPOR_WORK_ACCEPT > repo .spor.json > user config > default — the flag is
  // checked here, everything else rides the ordinary cascade. An unknown value
  // REFUSES to start the worker, same posture as the numeric options above: a
  // typo'd policy on an unattended box must not silently become either one.
  const acceptRaw = values.accept != null ? values.accept : cfg.get("work.accept", workLoop.WORK_DEFAULTS.accept);
  const accept = String(acceptRaw).trim().toLowerCase();
  if (!workLoop.WORK_ACCEPT_POLICIES.includes(accept)) {
    bad.push(`${values.accept != null ? "--accept" : "work.accept"} ${String(acceptRaw).trim() === "" ? "(empty)" : acceptRaw} — expected one of: ${workLoop.WORK_ACCEPT_POLICIES.join(", ")}`);
  }
  if (bad.length) {
    for (const b of bad) err(`spor work: ${b}`);
    return 1;
  }

  // The GATE PIPELINE (task-spor-work-gate-pipeline), opt-in and graph-resident:
  // with no factory declared the loop runs exactly as it shipped. A declared one
  // that cannot be read or does not validate REFUSES to start the worker —
  // gates are enforcement, and the one thing a mistyped definition must never
  // produce is a worker that silently accepts everything.
  const factoryId = values.factory || cfg.get("work.factory", null) || null;
  let factory = null;
  if (factoryId) {
    const loaded = await loadFactoryDefinition(cfg, factoryId);
    if (!loaded.factory) {
      err(`spor work: the factory definition '${factoryId}' cannot be used:`);
      for (const e of loaded.errors) err(`  ${e}`);
      err("  a worker does not run ungated on a definition it could not read — fix the factory node, or drop --factory/work.factory.");
      return 1;
    }
    factory = loaded.factory;
    // task-spor-propose-gh-capability-satisfiability: `gh` is a declared
    // capability, checked through the SAME machine-profile satisfiability
    // layer as a profile's harness/mcp/skills/plugins
    // (dec-spor-machine-profile-satisfiability), not a one-off startup PATH
    // probe that kills the whole worker. A mixed fleet may point several
    // boxes at the same propose factory/queue and only some have gh — a box
    // that can't ever land a proposal should idle (skipping every candidate
    // here, visibly, in `spor work --status`, and leaving them for a
    // capable box) rather than crash-loop under a service supervisor. Warn
    // once, loudly, so an operator watching THIS box's own log still learns
    // why nothing here ever dispatches; the per-item check below is what
    // actually stops a claim. `proposeIntegrationPR`/`ghPrStatus` keep their
    // own `hasCmd("gh")` checks as the backstop at the point `gh` is
    // actually invoked — the guarantee must never rest on this check having
    // run.
    const startupGh = integrationSatisfiability(cfg, factory);
    if (!startupGh.ok) {
      err(`spor work: factory '${factoryId}' declares integration mode 'propose', but ${startupGh.reasons[0]}`);
      err("  every candidate under this factory will be skipped here (see 'spor work --status') until gh is available, or run this worker on a box that has it.");
    }
  }
  // A standing `dispatch.claudeLaunchMode: native-background` is honored by an
  // interactive `spor dispatch` and IGNORED by every dispatch this loop makes
  // (dispatchThroughLocked passes `supervisedOnly`: a worker's runs must be
  // followable, judgeable and gateable, which only the supervised arm's report
  // channel and enforced outcome give). Ignoring a knob the operator set is
  // fine; ignoring it SILENTLY is not — say so once, here, where an operator
  // reading the worker's log will see it (task-spor-work-honor-claude-launch-
  // mode-and-retire-native-precheck). Same wording for --print and a real run.
  const configuredLaunchMode = cfg.get("dispatch.claudeLaunchMode", null) || null;
  if (configuredLaunchMode === "native-background") {
    err("spor work: dispatch.claudeLaunchMode is 'native-background', which this worker ignores — every run it dispatches (implementers, agent-review gates, fix cycles, rescues) is launched SUPERVISED (claude -p under the supervisor) so it can be followed, judged and gated; the setting still applies to an interactive 'spor dispatch'.");
  } else if (configuredLaunchMode && configuredLaunchMode !== "supervised") {
    err(`spor work: dispatch.claudeLaunchMode '${configuredLaunchMode}' is not recognized (supervised | native-background) — ignoring it; this worker always launches supervised.`);
  }
  // The factory's repo scope (issue-spor-work-scope-union-factory-mismatch).
  // Two distinct jobs, and only the second is load-bearing:
  //   - the queue SCOPE TOKEN, which just decides how wide a page we read. A
  //     single-repo factory with no explicit --project defaults it to that
  //     repo's slug — the token an operator would type, union semantics and
  //     all — rather than reading every project's queue and discarding most
  //     of it. Deliberately NOT the `repo-<slug>` node-id form: that pins a
  //     single repo only when such a node EXISTS, and silently yields an
  //     empty queue when it doesn't, which is a stalled worker with no
  //     message. A too-wide token costs a filtered candidate; a wrong-narrow
  //     one costs the work.
  //   - the GUARD below, which is what actually bounds the factory: whatever
  //     the token unions in, only items stamped with a repo this factory
  //     declares are candidates. That is the fix — the scope token is a
  //     read hint, the declared repos are the contract.
  const factoryRepos = (factory && factory.repos) || [];
  if (!explicitSlug && factoryRepos.length === 1) slug = factoryRepos[0];
  // A declared repo that names nothing in this graph is the quiet failure mode
  // of the whole feature: every item is out of scope, so the worker reads an
  // empty page (or filters the whole one away) and idles with nothing to say.
  // Say so at startup, where an operator is watching. A WARNING, not a
  // refusal: a repo whose identity node does not exist yet is not a typo. In
  // LOCAL mode the graph is right here (projectKnown); in REMOTE mode the
  // server answers the same question — GET /v1/queue?project=<repo> echoes a
  // zero-match token as the additive `project_warning` string
  // (task-spor-remote-next-print-project-warning) — so one bounded, fail-open
  // probe per declared repo asks it. The warning line is the SAME in both
  // modes (norm-spor-cli-mode-parity); a dead server, an error, or an older
  // server that omits the field says nothing here and falls back to the
  // loop's own scope-starvation notice.
  const unknownRepoWarning = (r) => `warning: factory '${factoryId}' declares repo '${r}', which names no repo or project in this graph — items stamped with it will never be found.`;
  if (factoryRepos.length && cfg.mode() === "local") {
    try {
      const graphLib = require(path.join(ROOT, "lib", "graph.js"));
      const g = graphLib.loadGraph(cfg.nodesDir());
      for (const r of factoryRepos) {
        if (!graphLib.projectKnown(g, r)) err(unknownRepoWarning(r));
      }
    } catch {
      /* an unreadable graph is the queue read's problem to report, not this check's */
    }
  } else if (factoryRepos.length && cfg.mode() === "remote") {
    for (const r of factoryRepos) {
      try {
        const res = await remote.get(cfg, `/v1/queue?project=${encodeURIComponent(r)}&limit=1`, { timeoutMs: 3000 });
        const warning = res.ok ? takeProjectWarning(res.json) : null;
        if (!warning) continue;
        // The server's text is the authoritative answer, so print it VERBATIM
        // (the acceptance: byte-matching what `spor next --project <typo>`
        // prints), then the factory-shaped context line local mode prints. The
        // verbatim line goes through the once-per-token printer so a
        // single-repo factory — whose page read is scoped to this same repo and
        // carries the same field — says it once, while a multi-repo factory —
        // whose page read is UNSCOPED and never sees it — still says it per repo.
        warnQueueProjectOnce(r, warning);
        err(unknownRepoWarning(r));
      } catch {
        /* fail-open: an unreachable server is the queue read's problem to report */
      }
    }
  }

  // Passed straight through to every dispatch this loop makes. Deliberately NOT
  // --force: a loop that forces past the duplicate/resolved guards is exactly
  // the runaway a pull worker must not be.
  const passthrough = {};
  // The harness-specific flags come from the harness module's own list, so a
  // new one rides without a second edit here.
  for (const k of ["profile", "model", "as", "template", "dir"].concat(Object.keys(dispatchHarnesses.HARNESS_OPTION_FLAGS))) {
    if (values[k]) passthrough[k] = values[k];
  }
  // NOT --no-claim either: the lease is the ONLY thing that keeps two pull
  // workers off one node (dec-cc-task-claim-lease), so a loop that dispatches
  // without one is exactly the collision this design rules out. A human aiming
  // one agent at one node can still opt out with `spor dispatch --no-claim`.
  for (const k of ["worktree", "no-worktree", "no-brief", "full", "allow-person-token"]) {
    if (values[k]) passthrough[k] = true;
  }

  // Read before `candidates` closes over it: `--print` calls that closure
  // before the loop starts, so this cannot be declared further down.
  const home = cfg.userConfigHome();

  // `--regate <run>`: re-judge one refused run under this factory and exit —
  // no polling, no dispatching (task-spor-work-regate).
  if (values.regate) {
    return cmdWorkRegate(cfg, values, { factory, factoryId, slug, passthrough, warn: (line) => err(line), runMaxMs, home });
  }

  const candidates = async ({ cooling = null } = {}) => {
    // Items already being worked by an agent on THIS box — this loop's earlier
    // runs, a hand-run `spor dispatch`, another loop — are not candidates. The
    // same-machine guard would refuse them anyway; skipping them here keeps a
    // refusal (and a cooldown entry) out of the status surface for something
    // that is simply already being done.
    const agents = dispatchedAgents(cfg);
    // ...and neither are items ANOTHER live worker on this box is gating. The
    // loop already subtracts its OWN gating slots, but nothing else would stop
    // a second worker here: a gated run is terminal, so it has no live agent
    // for the in-flight guard to see, and an unenforced `reported` one has
    // already handed its lease back. Both workers would then dispatch the node
    // the first one's gate is still judging.
    const gating = factory ? workLoop.gatingNodeIds(workLoop.readWorkerStatuses(home, { alive: workerAlive })) : null;
    // What makes an item worth a slot THIS pass, evaluated ON THE PAGE so the
    // fetch can widen past a page that holds none (the starvation the fixed
    // page size otherwise makes permanent — see dispatchableQueuePage). The
    // loop's cooldowns are part of it (`cooling`, passed in per pass): a
    // deterministic refusal — a profile this box cannot satisfy — cools the
    // same item forever, so without this the page would stop widening at that
    // item and everything ranked below it would starve exactly as before. A
    // page whose only eligible items are cooling is a pass with nothing to
    // dispatch, which is precisely when a deeper read is free.
    const scope = gatesKernel.repoScope(factoryRepos);
    const eligible = (it) =>
      !(agents.get(it.id) || []).length &&
      !(gating && gating.has(it.id)) &&
      !(cooling && cooling(it.id)) &&
      workLoop.pageEligible(it, { accept, repos: factoryRepos, scope });
    // Page deeper than the default when the cap is high: the page is filtered
    // again below (in-flight) and again by the loop (readiness, cooldowns), so
    // a page the size of the cap could not fill it.
    // Page deeper when a factory scope will discard part of it: the queue is
    // ranked across the whole scope token, so a grouping's sibling repos can
    // otherwise fill the page and starve a worker that has eligible work
    // further down.
    const page = await dispatchableQueuePage(cfg, slug, Math.max(factoryRepos.length ? 50 : 25, concurrency * 4), { eligible });
    const items = annotateInFlight(page, agents, true).items;
    if (!gating) return items;
    return gating.size ? items.filter((it) => !gating.has(it.id)) : items;
  };

  if (values.print || values["dry-run"]) {
    out(`project: ${slug || "(all projects)"}`);
    out(`accept:  ${accept} — ${accept === "open" ? "any queue item except readiness:human (untriaged included)" : "only items explicitly stamped agent-ready (--accept open for the looser pickup)"}`);
    out(`loop:    concurrency ${concurrency}, interval ${intervalMs / 1000}s, backoff to ${maxIntervalMs / 1000}s, retry refused after ${retryAfterMs / 1000}s, stop following a run after ${runMaxMs / 3600000}h${runIdleMs > 0 ? `, stop a run idle for ${runIdleMs / 60000}m` : ""}${max ? `, stop after ${max}` : ""}`);
    out(`status:  ${workLoop.workDir(cfg.userConfigHome())}`);
    if (factory) {
      out(`factory: ${factoryId} — trusted ref ${factory.trustedRef}${factory.protectedPaths.length ? `, protected ${factory.protectedPaths.join(" ")} -> ${factory.testLaneProfile}` : ""}`);
      out(`  judges: ${factoryRepos.length ? `repo(s) ${factoryRepos.join(", ")} — items stamped with any other repo are skipped` : "any repo (no 'repos' declared and no project stamp on the factory node)"}`);
      for (const g of factory.gates) {
        const how =
          g.kind === "command" ? `\`${g.command}\`` : g.kind === "agent-review" ? `review under ${g.profile}` : `approval${g.risk.length ? ` when ${g.risk.join("/")}` : " (always)"}`;
        out(`  gate ${g.id}  ${g.kind}  ${how}${g.cycles ? `  (up to ${g.cycles} fix cycle${g.cycles === 1 ? "" : "s"})` : ""}${g.source !== "inline" ? `  [${g.source}]` : ""}`);
      }
      if (factory.rescue) out(`  rescue: under ${factory.rescue.profile}, up to ${factory.rescue.attempts} attempt${factory.rescue.attempts === 1 ? "" : "s"} before any human escalation`);
      const ghVerdict = integrationSatisfiability(cfg, factory);
      if (!ghVerdict.ok) out(`  integration: mode 'propose' — UNSATISFIABLE here: ${ghVerdict.reasons[0]}`);
    } else {
      out(`factory: none — the loop runs bare (declare one with --factory <id> or work.factory)`);
    }
    const policySkips = [];
    const cands = workLoop.selectWorkCandidates(await candidates(), { accept, repos: factoryRepos, onSkip: (it, reason) => policySkips.push({ it, reason }) });
    if (!cands.length) out("queue:   nothing dispatchable right now");
    else {
      out(`queue:   ${cands.length} candidate(s); this pass would take the first ${Math.min(concurrency, cands.length)}`);
      for (const [i, it] of cands.entries()) {
        out(`  ${i < concurrency ? "->" : "  "} ${it.id}  ${it.readiness || "untriaged"}  ${it.title || it.summary || ""}`.slice(0, 160));
      }
    }
    // Same treatment as the loop's own log and `--status`: a widened page can
    // hold hundreds of skips, and a preview that scrolls them all off the
    // screen hides its own answer.
    for (const { it, reason } of policySkips.slice(0, workLoop.SKIP_LOG_CAP)) out(`  skip ${it.id}  ${it.readiness || "untriaged"}  ${reason}`.slice(0, 160));
    if (policySkips.length > workLoop.SKIP_LOG_CAP) {
      out(`  ...and ${policySkips.length - workLoop.SKIP_LOG_CAP} more skipped — ${workLoop.summarizeSkips(policySkips.slice(workLoop.SKIP_LOG_CAP).map((p) => p.reason))}`);
    }
    out(`\nnothing was launched (--print). Each item would go through 'spor dispatch --node <id>', whose guards decide.`);
    return 0;
  }

  const workerId = crypto.randomUUID();
  // Sweep aged-out worker records now: pruning otherwise only happens inside a
  // `--status` read, so a box running `spor work --once` on a cron and never
  // reading the status back would accumulate one record per invocation forever.
  workLoop.readWorkerStatuses(home, { alive: workerAlive });
  const control = { stopping: false, reason: null, wake: () => {} };
  // A service manager stops a worker with a signal, so a signal must reach the
  // loop mid-backoff rather than at the end of it: wake() collapses the pending
  // sleep. A SECOND signal is the operator insisting — exit immediately.
  const onSignal = (sig) => {
    if (control.stopping) process.exit(130);
    control.stopping = true;
    control.reason = `stopped on ${sig}`;
    // Straight to stderr, NOT through err(): a signal arriving mid-dispatch
    // would otherwise land in that dispatch's captured lines and could become
    // the item's recorded skip reason.
    process.stderr.write(`work: ${sig} — not picking up new work. In-flight runs keep going and self-report ('spor runs').\n`);
    control.wake();
  };
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => onSignal(sig));

  // Latched: a persistently unreadable harness listing warns about each held
  // run ONCE, not once per poll — the same sentence `spor runs` prints once per
  // invocation, not 11k lines a day into a service log.
  const warned = new Set();
  const warn = (line) => {
    if (warned.has(line)) return;
    warned.add(line);
    err(line);
  };

  out(`work: worker ${workerId.slice(0, 8)} — ${slug || "all projects"}, accept ${accept}, concurrency ${concurrency}, poll ${intervalMs / 1000}s${max ? `, stopping after ${max} dispatch(es)` : ""}`);
  if (factoryRepos.length) out(`work: factory ${factoryId} judges repo(s) ${factoryRepos.join(", ")} — items from any other repo are skipped, not gated`);
  out(`work: status at ${workLoop.workerStatusPath(home, workerId)}  ('spor work --status')`);
  // What code this worker runs, said once up front and re-checked each pass
  // (task-spor-work-announce-lib-commit-and-notice-main-moved): a long-running
  // worker keeps the lib/bin it loaded, so a fix that lands on main after
  // startup does not reach its pipelines until it is restarted.
  const loadedCode = loadedCodeCommit(ROOT);
  out(
    loadedCode
      ? `work: running ${ROOT} at ${loadedCode.commit}${loadedCode.branch ? ` (${loadedCode.branch})` : ""} — a worker keeps the code it loaded; restart it after a land you want it to run`
      : `work: running @sporhq/spor ${require(path.join(ROOT, "package.json")).version} from ${ROOT} — a worker keeps the code it loaded; restart it after an upgrade you want it to run`
  );
  // The ref watched is the factory's integration target when it resolves in
  // this checkout (a self-hosting factory lands onto it), else the branch the
  // code was loaded from — never bare HEAD while a branch is known, so a branch
  // switch or bisect in a linked worker checkout is not mistaken for a land.
  const watchRef = codeWatchRef(loadedCode, { root: ROOT, targetRef: factory && factory.integration ? factory.integration.targetRef : null });
  if (loadedCode && watchRef) out(`work: watching ${watchRef} in ${ROOT} for a commit that moves past ${loadedCode.commit}`);
  const noticeCode = makeCodeMovedNotice(loadedCode, { root: ROOT, log: (line) => out(line), ref: watchRef });
  // The flag needs a checkout to watch: an npm install never moves under the
  // worker (it is replaced by an upgrade), so say once that it is inert.
  if (restartOnLand && !loadedCode) out(`work: --restart-on-land has nothing to watch — ${ROOT} is not a source checkout; the worker runs until stopped`);
  const final = await workLoop.runWorkLoop({
    opts: {
      workerId, project: slug, accept, repos: factoryRepos, concurrency, intervalMs, maxIntervalMs, retryAfterMs, max, once: !!values.once, factory: factoryId, restartOnLand,
      // The pid-reuse guard for this record: a SIGKILLed worker leaves no
      // stopped_at, and a bare pid probe would read its recycled pid as this
      // worker still running (the same identity check the run store makes).
      startedTicks: dispatchRuns.processStartTicks(process.pid),
    },
    control,
    deps: {
      noticeCode,
      candidates,
      // Refuse BEFORE any side effect if this machine can't satisfy the
      // loaded factory's integration requirement (task-spor-propose-gh-
      // capability-satisfiability) — mirrors cmdDispatch's own profile-
      // satisfiability refusal (dec-spor-machine-profile-satisfiability):
      // never call through to dispatchWorkItem/cmdDispatch, so no lease is
      // ever established for an item this box can never finish landing. The
      // loop's existing refusal-cooldown machinery does the rest — the same
      // path any other unsatisfiable-profile refusal already takes.
      dispatch: (item) => {
        if (factory) {
          const verdict = integrationSatisfiability(cfg, factory);
          if (!verdict.ok) return { ok: false, reason: verdict.reasons[0] };
        }
        return dispatchWorkItem(cfg, item, passthrough, { factory });
      },
      pollRuns: (ids) => pollWorkRuns(cfg, ids, { maxAgeMs: runMaxMs, idleMs: runIdleMs, warn }),
      publish: (status) => workLoop.writeWorkerStatus(home, status),
      log: (line) => out(line),
      // Present only when a factory resolved, so a bare worker's deps — and its
      // behavior — are byte-identical to what shipped.
      ...(factory
        ? {
            // The durable half of the gate verdict, and the scan that reads it
            // back (WORKERS.md §10.8). A gate pipeline is the one piece of work
            // this PROCESS owns, so a worker that dies mid-pipeline leaves a
            // terminal run standing with an un-judged claim — and that run is
            // already out of the queue, so no candidate poll would ever return
            // to it. The pair of durable records this box already keeps (the
            // per-worker status files + the run journal) is what makes it
            // recoverable by any later worker.
            markGate: (runId, patch) => dispatchRuns.stampGateState(home, runId, patch),
            pendingGates: () => {
              const statuses = workLoop.readWorkerStatuses(home, { alive: workerAlive });
              // The cheap half of the join first. On a busy box the run journal
              // is thousands of files (14-day retention) and the answer is
              // almost always "no orphans", so reading it every poll to learn
              // that would be the loop's dominant cost. No dead worker holding
              // a slot ⇒ nothing to resume, without touching the journal.
              // A foreign orphan is never adoptable, so it must not keep this
              // guard open either — otherwise one stranded pipeline makes every
              // poll read the whole run journal for its whole 7-day retention.
              const mine = (w) => !factoryId || !w.factory || w.factory === factoryId;
              if (!statuses.some((w) => !w.live && mine(w) && ((w.gating || []).length || (w.active || []).length))) return [];
              return workLoop.orphanedGateRuns(statuses, {
                records: new Map(dispatchRuns.readRunRecords(home).map((r) => [r.run_id, r])),
                // Only pipelines THIS factory started (issue-spor-work-scope-
                // union-factory-mismatch): resumption never goes through
                // candidate selection, so without this the repo-scope guard has
                // a back door straight into another factory's repo.
                factory: factoryId,
                onForeign: (slot) =>
                  warn(
                    `work: not resuming the gate pipeline for ${slot.node_id} (run ${String(slot.run_id).slice(0, 8)}) — ` +
                      `it was started under factory '${slot.factory}', not '${factoryId}'. Run a worker armed with that factory to finish it.`
                  ),
                // The run store owns the terminal vocabulary; the scan needs it
                // to tell a node an agent may still be working from one that is
                // genuinely idle (a resumed pipeline re-dispatches fix cycles).
                terminalStates: dispatchRuns.TERMINAL_STATES,
                maxAgeMs: runMaxMs,
              });
            },
            gate: (entry, record) =>
              runGateAndIntegration(cfg, entry, record, {
                factory,
                slug,
                passthrough,
                warn,
                runMaxMs,
                log: (line) => out(line),
                stopping: () => !!control.stopping,
                // A plain timer, NOT the loop's wakeable sleep: that one has a
                // single wake slot the loop owns, and a gate sharing it would
                // silently cancel the loop's own backoff.
                sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
              }),
            // task-spor-integration-propose-mode: only present under propose
            // mode, so every OTHER factory's loop is byte-identical to before
            // this existed. Runs once per pass, outside the slot/concurrency
            // accounting — it never opens a candidate worktree or a run, just
            // reads this box's own run journal and a handful of `gh` calls.
            ...(factory.integration && factory.integration.mode === "propose"
              ? { checkProposals: () => checkProposals(cfg, { home, log: (line) => out(line) }) }
              : {}),
          }
        : {}),
      sleep: (ms) =>
        new Promise((resolve) => {
          const done = () => {
            control.wake = () => {};
            resolve();
          };
          const t = setTimeout(done, ms);
          control.wake = () => {
            clearTimeout(t);
            done();
          };
        }),
    },
  });
  const o = final.outcomes;
  out(`work: ${final.stop_reason}. dispatched ${final.dispatched}; resolved ${o.resolved}, reported ${o.reported}, failed ${o.failed}${o.unenforced ? ` (${o.unenforced} unenforced)` : ""}.`);
  if (final.gates) {
    out(
      `work: gates — passed ${final.gates.passed}, failed ${final.gates.failed}, blocked ${final.gates.blocked}${
        final.gates.parked ? `, parked ${final.gates.parked}` : ""
      }${final.gates.superseded ? `, superseded ${final.gates.superseded}` : ""} (factory ${factoryId}).`
    );
  }
  if (final.active.length) out(`work: ${final.active.length} run(s) still in flight — 'spor runs' follows them to their terminal state.`);
  // A signal-driven stop has to actually END this process. runWorkLoop itself
  // returns promptly on a stop — it never awaits a gate pipeline's own promise
  // (work-loop.js's stop-condition step) — but an ABANDONED pipeline's
  // in-process wait (a fix cycle's or review's awaitGateRun poll, a command
  // gate's suite timer) is a live Node timer this process still holds, and
  // Node does not exit while one is pending: without this, a "stopped" worker
  // would keep running — silently, doing nothing new, but still a live
  // process — for up to that gate's own timeout (a day, for a fix cycle)
  // instead of actually stopping (issue-spor-work-stop-abandons-inflight-
  // gates). The dispatched runs this worker started (including any fix
  // cycle's) are detached OS processes and keep going unaffected by this
  // process exiting — that is the whole point of `gate_fix_run_id` durably
  // naming one (makeGateDeps' `fix`, above): nothing here waits for them, and
  // nothing needs to.
  if (control.stopping) {
    // `out()` writes are fire-and-forget, and process.stdout.write to a pipe
    // is asynchronous — exiting right after queuing the lines above (the
    // abandoned-pipeline notice, the fix-cycle run id) can truncate exactly
    // the diagnostic output this feature exists to produce. This codebase
    // already knows and guards against the same hazard (cmdExport awaits a
    // flush callback before its caller's process.exit, bin/spor.js's `export`
    // handler); a zero-byte write's callback fires only once every
    // already-queued write ahead of it has drained (a Writable stream
    // processes writes strictly in order), so this waits out `out()`'s queue
    // without emitting anything new.
    await new Promise((resolve) => process.stdout.write("", resolve));
    process.exit(0);
  }
  return 0;
}

// --- repo-identity tags (task-cc-repos-tag-ergonomic) ---------------------
// Repo tags are the match key for a norm's `applies_to_tags` ride-along (schema-
// repo, schema-norm): a norm scoped `applies_to_tags: [python]` rides into a
// session's briefing only when the session's OWN repo node is tagged `python`,
// and an UNTAGGED repo strictly EXCLUDES every tag-scoped norm — so unset tags
// silently disable the feature. Until now the only way to set them was hand-
// editing the `repo-<slug>` node's frontmatter (local) or a put_node (remote);
// `spor repos tag`/`untag`/`tags` make tagging a first-class operation, the
// deliberate opt-in that turns scoped norms on. They write the same inline
// `tags:` list session-start maintains for slugs/fingerprints — one more repo-
// identity register beside them — and mirror the slug/fingerprint heal flow
// rather than inventing a new surface (the node, not the dispatch map, is the
// store; the dispatch map only locates the checkout for auto-suggest).
// Slugs share the node-id grammar (the server's SLUG_RE == ID_RE) — reuse the
// module-level NODE_ID_RE rather than a second const that can drift from it.
const TAG_RE = /^[a-z0-9][a-z0-9._-]*$/; // a flat label safe for the inline-list grammar

// Normalize raw tag tokens: lowercase, trim, dedupe (order-preserving), reject
// anything that won't round-trip the inline `[a, b]` list grammar. {tags}|{error}.
function normalizeTags(rawTags) {
  const tags = [];
  const seen = new Set();
  for (const raw of rawTags) {
    const tag = String(raw).trim().toLowerCase();
    if (!tag) continue;
    if (!TAG_RE.test(tag)) return { error: `invalid tag '${raw}' — tags are lowercase labels matching ${TAG_RE.source} (no spaces, commas, or brackets)` };
    if (seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return { tags };
}

// Read the inline `tags:` list off a repo node's raw markdown (frontmatter
// only), mirroring the kernel's inline-list parse. [] when absent.
function tagsFromRaw(raw) {
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  const fm = m ? m[1] : ""; // no frontmatter fence -> no tags (never scan the body)
  const t = /^tags:\s*\[([^\]]*)\]/m.exec(fm);
  return t ? t[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
}

// Rewrite a repo node's raw markdown to carry `tags` as its inline `tags:` list,
// mirroring rewriteStatus/appendEdgeLine. An empty array removes the field. The
// line is grouped with the other identity registers (after fingerprints/slugs)
// when present, else appended to the frontmatter. Returns the new raw, or null
// when the frontmatter can't be located.
function rewriteTags(raw, tags) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const body = m[2];
  const lines = m[1].split("\n").filter((l) => !/^tags:\s*/.test(l));
  if (tags.length) {
    const line = `tags: [${tags.join(", ")}]`;
    let anchor = -1;
    for (let i = 0; i < lines.length; i++) if (/^(fingerprints|slugs):\s*/.test(lines[i])) anchor = i;
    if (anchor === -1) lines.push(line);
    else lines.splice(anchor + 1, 0, line);
  }
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

// Order-insensitive set equality, so a no-op tag edit skips the write (and, in
// remote mode, an unnecessary put_node + commit).
function sameTags(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

// Auto-suggest candidate tags from a repo's files on disk — a deliberate hint a
// human confirms, never an auto-commit (the slug-alias confirmation queue is the
// model). Cheap: one top-level directory read, exact filenames + the *.tf glob
// the task calls out. The named three (terraform/python/go) plus a few obvious,
// unambiguous markers.
const TAG_DETECTORS = [
  { tag: "terraform", any: (names) => names.some((n) => n.endsWith(".tf")) },
  { tag: "python", files: ["pyproject.toml", "uv.lock", "setup.py", "requirements.txt", "Pipfile"] },
  { tag: "go", files: ["go.mod"] },
  { tag: "node", files: ["package.json"] },
  { tag: "rust", files: ["Cargo.toml"] },
  { tag: "ruby", files: ["Gemfile"] },
  { tag: "docker", files: ["Dockerfile", "compose.yaml", "docker-compose.yml"] },
];
function detectRepoTags(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const set = new Set(names);
  const out = [];
  for (const d of TAG_DETECTORS) {
    if (d.any ? d.any(names) : d.files.some((f) => set.has(f))) out.push(d.tag);
  }
  return out;
}

// Where this slug's checkout lives on disk, for auto-suggest: the machine-local
// dispatch.repos map (the authoritative, other half of `spor repos`) first, else
// the current repo ROOT — but only when the ROOT'S OWN inferred slug matches, so
// a monorepo-subtree marker slug (whose root infers a different slug) doesn't
// scan the wrong directory. null when unknown — suggestion is then skipped.
function repoDirForSlug(cfg, slug) {
  const map = cfg.get("dispatch.repos", {}) || {};
  if (map[slug]) return map[slug];
  const root = u.inferenceRoot(process.cwd());
  return root && u.projectSlug(root) === slug ? root : null;
}

function noRepoNodeMsg(id, slug) {
  return `no repo identity node '${id}' — it self-registers when you open a session in that repo (or run 'spor backfill'); list them with 'spor repos tags'`;
}
function tagSetMsg(id, tags) {
  return tags.length ? `tags set: ${id} -> [${tags.join(", ")}]` : `tags cleared: ${id}`;
}

// Read a repo-<slug> node's raw markdown in either mode: remote GETs
// /v1/nodes/{id} (raw + revision for the optimistic-concurrency update); local
// reads the node file. {raw, revision?}|{missing:true}|{error}.
async function readRepoNodeRaw(cfg, slug) {
  const id = `repo-${slug}`;
  if (cfg.mode() === "remote") {
    const g = await remote.get(cfg, `/v1/nodes/${encodeURIComponent(id)}`, { timeoutMs: 8000 });
    if (g.transport) return { error: `offline — could not reach server (${g.error})` };
    if (g.status === 404) return { missing: true };
    if (!g.ok) return { error: `error ${g.status}` };
    return { raw: (g.json && g.json.raw) || g.text, revision: g.json && g.json.revision };
  }
  const file = path.join(cfg.nodesDir(), `${id}.md`);
  try {
    return { raw: fs.readFileSync(file, "utf8") };
  } catch {
    return { missing: true };
  }
}

// Write a repo-<slug> node's new raw markdown in either mode: remote does the
// documented whole-node update (put_node, if_exists:update + revision — no
// dedicated /tags endpoint, consistent with how slug aliases are filed); local
// validates against the registry (the same bar as priority/set-status) before
// writing the file. {ok:true}|{error}.
async function writeRepoNodeRaw(cfg, slug, newRaw, revision) {
  const id = `repo-${slug}`;
  if (cfg.mode() === "remote") {
    const pr = await remote.post(cfg, "/v1/nodes", { nodes: [{ node: newRaw, if_exists: "update", revision }] }, { timeoutMs: 8000 });
    if (pr.transport) return { error: `offline — could not reach server (${pr.error})` };
    // A 207 with a failed single-node entry IS a failure here (unlike a multi-node
    // batch) — gate on the entry's own ok, and surface the server's generic
    // message plus its granular `details` list (the validator's specifics).
    const res0 = pr.json && pr.json.results && pr.json.results[0];
    if (!(res0 && res0.ok)) {
      const parts = [];
      if (res0 && res0.message) parts.push(res0.message);
      if (res0 && Array.isArray(res0.details)) parts.push(...res0.details);
      return { error: `tag error ${pr.status}${parts.length ? `: ${parts.join("; ")}` : ""}` };
    }
    return { ok: true };
  }
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  const nodesDir = cfg.nodesDir();
  let g;
  try {
    g = graphLib.loadGraph(nodesDir);
  } catch (e) {
    return { error: `could not load graph: ${e.message}` };
  }
  let node;
  try {
    node = graphLib.parseFrontmatter(newRaw, `${id}.md`);
  } catch (e) {
    return { error: `invalid node after tag edit: ${e.message}` };
  }
  const v = graphLib.validateNode(g, node);
  if (!v.ok) return { error: `invalid node after tag edit:\n  ${v.errors.join("\n  ")}` };
  fs.writeFileSync(path.join(nodesDir, `${id}.md`), newRaw);
  return { ok: true };
}

// Read-modify-write the repo-<slug> node's tags. `computeNext(current)` returns
// the new tag set ({tags}|{error}); a no-op set skips the write entirely.
async function mutateRepoTags(cfg, slug, computeNext) {
  const id = `repo-${slug}`;
  const r = await readRepoNodeRaw(cfg, slug);
  if (r.error) {
    err(r.error);
    return 1;
  }
  if (r.missing) {
    err(noRepoNodeMsg(id, slug));
    return 1;
  }
  const current = tagsFromRaw(r.raw);
  const next = computeNext(current);
  if (next.error) {
    err(next.error);
    return 1;
  }
  if (sameTags(current, next.tags)) {
    out(current.length ? `tags unchanged: ${id} -> [${current.join(", ")}]` : `tags unchanged: ${id} (none)`);
    return 0;
  }
  const newRaw = rewriteTags(r.raw, next.tags);
  if (newRaw == null) {
    err(`could not locate frontmatter in ${id}`);
    return 1;
  }
  const w = await writeRepoNodeRaw(cfg, slug, newRaw, r.revision);
  if (w.error) {
    err(w.error);
    return 1;
  }
  out(tagSetMsg(id, next.tags));
  return 0;
}

// `spor repos tag <slug>` with no tags: show current tags and auto-suggest
// candidates from the checkout on disk, writing NOTHING.
async function cmdReposTagSuggest(cfg, slug) {
  const id = `repo-${slug}`;
  const r = await readRepoNodeRaw(cfg, slug);
  if (r.error) {
    err(r.error);
    return 1;
  }
  if (r.missing) {
    err(noRepoNodeMsg(id, slug));
    return 1;
  }
  const current = tagsFromRaw(r.raw);
  out(`${id}: ${current.length ? `[${current.join(", ")}]` : "(no tags)"}`);
  const dir = repoDirForSlug(cfg, slug);
  if (!dir) {
    out(`(no checkout mapped for '${slug}' — 'spor repos add ${slug} <path>' to enable tag auto-suggest)`);
    return 0;
  }
  const suggested = detectRepoTags(dir).filter((t) => !current.includes(t));
  if (!suggested.length) {
    out(`(no new tag candidates detected in ${dir})`);
    return 0;
  }
  out(`suggested (from ${dir}): ${suggested.join(" ")}`);
  out(`  apply: spor repos tag ${slug} ${[...current, ...suggested].join(" ")}`);
  return 0;
}

// `spor repos tags`: list every repo-identity node with its slugs + tags. Dual-
// mode — local reads the graph home; remote runs the same enumeration over a
// freshly-fetched team graph (GET /v1/export), the graph-wide-sweep path `spor
// query` uses.
async function cmdReposTagList(cfg) {
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  let nodesDir, cleanup = () => {};
  if (cfg.mode() === "remote") {
    const fetched = await fetchRemoteExportNodes(cfg, "repos");
    if (fetched.error) return 1;
    nodesDir = fetched.nodesDir;
    cleanup = fetched.cleanup;
  } else {
    nodesDir = cfg.nodesDir();
  }
  try {
    let g;
    try {
      g = graphLib.loadGraph(nodesDir);
    } catch (e) {
      err(`could not load graph: ${e.message}`);
      return 1;
    }
    const repos = Object.values(g.nodes)
      .filter((n) => n.type === "repo")
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!repos.length) {
      out("no repo identity nodes yet — they self-register as you open sessions");
      return 0;
    }
    for (const n of repos) {
      const slugs = Array.isArray(n.slugs) ? n.slugs : [];
      const tags = Array.isArray(n.tags) ? n.tags : [];
      out(`${n.id}\tslugs: [${slugs.join(", ")}]\ttags: [${tags.join(", ")}]`);
    }
    return 0;
  } finally {
    cleanup();
  }
}

// --- spor repos: the local slug->path map + repo-identity tags ------------
async function cmdRepos(cfg, args) {
  // The map is machine-local: written to the PERSONAL user config home, never
  // the (possibly marker-shared) graph home. Reads still go through the cascade
  // below (cfg.get), whose user layer is anchored at this same home, so writes
  // round-trip (issue-spor-config-desync-shared-graph-home).
  const home = cfg.userConfigHome();
  const sub = args[0];
  if (!sub || sub === "list") {
    // Resolved through the config cascade (dispatch.repos), so user, global, and
    // any repo/env override layers compose; writes land in $SPOR_HOME/config.json.
    const map = cfg.get("dispatch.repos", {}) || {};
    const keys = Object.keys(map).sort();
    if (!keys.length) {
      out("no repos mapped yet — they self-register as you open sessions, or: spor repos add <slug> <path>");
      return 0;
    }
    for (const k of keys) out(`${k}\t${map[k]}`);
    return 0;
  }
  if (sub === "add" || sub === "set") {
    const slug = args[1];
    const p = args[2];
    if (!slug || !p) {
      err("usage: spor repos add <slug> <path>");
      return 1;
    }
    if (!NODE_ID_RE.test(slug)) {
      err(`invalid slug '${slug}' — must match ^[a-z0-9][a-z0-9-]*$`);
      return 1;
    }
    const abs = path.resolve(p);
    u.registerRepo(home, slug, abs);
    out(`mapped ${slug} -> ${abs}`);
    return 0;
  }
  if (sub === "rm" || sub === "remove" || sub === "forget") {
    const slug = args[1];
    if (!slug) {
      err("usage: spor repos rm <slug>");
      return 1;
    }
    out(u.forgetRepo(home, slug) ? `forgot ${slug}` : `no mapping for ${slug}`);
    return 0;
  }
  // Repo-identity tags on the repo-<slug> GRAPH node (not the dispatch map).
  if (sub === "tags") {
    return await cmdReposTagList(cfg);
  }
  if (sub === "tag" || sub === "untag") {
    const slug = args[1];
    if (!slug) {
      err(`usage: spor repos ${sub} <slug> [<tag>...]${sub === "untag" ? "  (no tags clears all)" : ""}`);
      return 1;
    }
    if (!NODE_ID_RE.test(slug)) {
      err(`invalid slug '${slug}' — must match ^[a-z0-9][a-z0-9-]*$`);
      return 1;
    }
    const rawTags = args.slice(2);
    if (sub === "tag" && !rawTags.length) {
      // bare `tag <slug>` => show current + auto-suggest, write nothing
      return await cmdReposTagSuggest(cfg, slug);
    }
    if (sub === "untag" && !rawTags.length) {
      // bare `untag <slug>` => clear all tags
      return await mutateRepoTags(cfg, slug, () => ({ tags: [] }));
    }
    const norm = normalizeTags(rawTags);
    if (norm.error) {
      err(norm.error);
      return 1;
    }
    if (sub === "tag") {
      // set/replace the repo's tag list with exactly these tags
      return await mutateRepoTags(cfg, slug, () => ({ tags: norm.tags }));
    }
    // untag: drop the named tags from the current list
    const remove = new Set(norm.tags);
    return await mutateRepoTags(cfg, slug, (current) => ({ tags: current.filter((t) => !remove.has(t)) }));
  }
  err("usage: spor repos [list] | add <slug> <path> | rm <slug> | tags | tag <slug> [tag...] | untag <slug> [tag...]");
  return 1;
}

// --- spor capabilities: this machine's dispatch capability map ------------
// The machine half of profile satisfiability (dec-spor-machine-profile-
// satisfiability): which harnesses/MCP/skills/plugins THIS box can run, matched
// against a profile's runtime fields at dispatch. Probe-populated +
// config-overridable, in the SAME machine-local config.json as dispatch.repos
// (never a committable .spor.json). Reads resolve through the cascade
// (dispatch.capabilities); writes target the personal user config home. The
// probe owns `.probed` (refreshed each session); these verbs own `.declared`
// (sticky) and `.deny` (policy) — declared AUGMENTS probed, deny overrides both.
function cmdCapabilities(cfg, args) {
  const home = cfg.userConfigHome();
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const sub = rest[0] || "list";
  const AXES = sat.CAP_AXES; // harnesses, reachable_mcp, skills, plugins

  const printList = () => {
    const cap = cfg.get("dispatch.capabilities", {}) || {};
    const eff = sat.effectiveCapabilities(cap);
    if (json) {
      out(JSON.stringify(eff, null, 2));
      return 0;
    }
    out(`harnesses:     ${eff.harnesses.join(", ") || "(none — no known harness binary on PATH; spor capabilities probe)"}`);
    out(`reachable_mcp: ${eff.reachable_mcp.join(", ") || "(none declared — spor capabilities allow-mcp <name>)"}`);
    out(`skills:        ${eff.skills.length ? eff.skills.join(", ") : "(none)"}`);
    out(`plugins:       ${eff.plugins.join(", ") || "(none)"}`);
    out(`deny:          ${eff.deny.length ? eff.deny.join(", ") : "(none)"}`);
    return 0;
  };

  // `show <agent-id>` reads a REMOTE agent's published fleet capabilities (GET
  // /v1/agents/{id}/capabilities) — the read twin of `publish`
  // (task-spor-capabilities-read-agent-cli-verb). With no agent id, `show`/`list`
  // print THIS box's LOCAL effective caps, unchanged (byte-identical). `me`
  // resolves to this machine's configured dispatch.agent.
  if (sub === "list" || sub === "show") {
    const target = sub === "show" && rest[1] && !rest[1].startsWith("-") ? rest[1] : null;
    if (target) return cmdCapabilitiesShow(cfg, { agentId: target, json });
    return printList();
  }

  // publish — PUSH this box's effective capabilities to the team server so the
  // remote fleet scheduler (task-spor-remote-fleet-scheduler) can host-match an
  // assigned profile against them: the remote twin of the LOCAL match `spor
  // dispatch` runs. Remote-only (a fleet needs a server); keyed on this
  // machine's dispatch.agent (the per-machine identity), so `spor agent use`
  // must have run first. Fail soft and loud, never block.
  if (sub === "publish") return cmdCapabilitiesPublish(cfg, { json });

  // hosts <profile-id> [--owner X] [--max-age D] — CONSUME the fleet scheduler:
  // which boxes satisfy this profile (re-route targets) and which don't, and why
  // (task-spor-fleet-scheduler-autoroute-dispatch). Remote-only.
  if (sub === "hosts") {
    const profileId = rest[1] && !rest[1].startsWith("-") ? rest[1] : null;
    const flagVal = (name) => {
      const i = rest.indexOf(name);
      return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith("-") ? rest[i + 1] : null;
    };
    return cmdCapabilitiesHosts(cfg, { profileId, owner: flagVal("--owner"), maxAge: flagVal("--max-age"), json });
  }

  if (sub === "probe") {
    // Seed reachable_mcp:[spor] from CONFIGURED-ness when a Spor server/connector
    // is bound (remote mode) — the spor MCP is reachable by construction, no
    // network ping (task-spor-mcp-reachability-deterministic-seed).
    const probed = u.probeCapabilities(home, { sporReachable: !!cfg.server(), cfg });
    out(`probed harnesses: ${probed.harnesses.join(", ") || "(none on PATH)"}`);
    out(`probed plugins:   ${probed.plugins.join(", ") || "(none)"}`);
    const sk = probed.skills.filter((s) => !s.includes(":")); // bare names, compact
    out(`probed skills:    ${probed.skills.length} (${sk.slice(0, 10).join(", ")}${sk.length > 10 ? " …" : ""})`);
    if (probed.reachable_mcp && probed.reachable_mcp.length) out(`probed reachable_mcp: ${probed.reachable_mcp.join(", ")} (Spor server configured)`);
    out(`written to dispatch.capabilities.probed in ${path.join(home, "config.json")}`);
    return 0;
  }

  // Mutate a sticky DECLARED axis: set replaces, add unions in, rm removes.
  if (sub === "set" || sub === "add" || sub === "rm" || sub === "remove") {
    const axis = rest[1];
    const vals = rest.slice(2).filter(Boolean);
    if (!AXES.includes(axis) || (sub !== "set" && !vals.length)) {
      err(`usage: spor capabilities ${sub} <${AXES.join("|")}> <value...>`);
      return 1;
    }
    u.editCapabilities(home, (cap) => {
      if (cap.declared == null || typeof cap.declared !== "object" || Array.isArray(cap.declared)) cap.declared = {};
      const cur = Array.isArray(cap.declared[axis]) ? cap.declared[axis] : [];
      let next;
      if (sub === "set") next = [...new Set(vals)];
      else if (sub === "add") next = [...new Set([...cur, ...vals])];
      else next = cur.filter((x) => !vals.includes(x));
      if (next.length) cap.declared[axis] = next;
      else delete cap.declared[axis];
      return true; // always (re)write — reporting reads the result below
    });
    return printList();
  }

  // allow-mcp / disallow-mcp — sugar for declaring reachable MCP (the axis a
  // probe can't decide). allow-mcp X == add reachable_mcp X.
  if (sub === "allow-mcp" || sub === "disallow-mcp") {
    const vals = rest.slice(1).filter(Boolean);
    if (!vals.length) {
      err(`usage: spor capabilities ${sub} <mcp-name...>`);
      return 1;
    }
    return cmdCapabilities(cfg, [sub === "allow-mcp" ? "add" : "rm", "reachable_mcp", ...vals, ...(json ? ["--json"] : [])]);
  }

  // deny / undeny — a profile id this box must NOT run (policy opt-out), not a
  // capability. Lives at top-level `deny`, overriding both probed and declared.
  if (sub === "deny" || sub === "undeny" || sub === "allow") {
    const vals = rest.slice(1).filter(Boolean);
    if (!vals.length) {
      err(`usage: spor capabilities ${sub} <profile-id...>`);
      return 1;
    }
    u.editCapabilities(home, (cap) => {
      const cur = Array.isArray(cap.deny) ? cap.deny : [];
      const next = sub === "deny" ? [...new Set([...cur, ...vals])] : cur.filter((x) => !vals.includes(x));
      if (next.length) cap.deny = next;
      else delete cap.deny;
      return true;
    });
    return printList();
  }

  if (sub === "clear" || sub === "reset") {
    const wrote = u.editCapabilities(home, (cap) => {
      let changed = false;
      for (const k of ["probed", "declared", "deny", ...AXES]) {
        if (k in cap) {
          delete cap[k];
          changed = true;
        }
      }
      return changed;
    });
    out(wrote ? "capabilities cleared (declarations + probe cache reset)" : "nothing to clear");
    return 0;
  }

  err(
    "usage: spor capabilities [list [--json]] | show <agent-id> [--json] | probe | publish | set <axis> <v...> | add <axis> <v...> | rm <axis> <v...>\n" +
      "       spor capabilities hosts <profile-id> [--owner X] [--max-age D] [--json]\n" +
      "       spor capabilities allow-mcp <name...> | deny <profile-id...> | undeny <profile-id...> | clear\n" +
      `       axes: ${AXES.join(", ")}`
  );
  return 1;
}

// cmdCapabilitiesPublish — push this box's EFFECTIVE capabilities to the team
// server's fleet scheduler (POST /v1/agents/{id}/capabilities,
// task-spor-remote-fleet-scheduler). The published body is the same
// effectiveCapabilities() collapse `spor capabilities` and `spor dispatch` read
// locally, but over a FRESH probe taken here (see below): this is the same path
// the session-start auto-publish runs, so a manual publish and the auto-publish
// agree — including the deterministic reachable_mcp:[spor] remote-mode seed,
// which a stale config could otherwise omit (issue-spor-capabilities-publish-
// manual-no-spor-seed). Remote-only, keyed on this machine's dispatch.agent.
// Fail soft and loud — a missing agent, undeployed surface, or unreachable
// server prints one clear line and exits non-zero, never throws.
async function cmdCapabilitiesPublish(cfg, { json }) {
  if (!remote.isRemote(cfg)) {
    err(
      "spor capabilities publish is remote-only — set a team server (SPOR_SERVER) first.\n" +
        "In local mode there is no fleet to publish to; capabilities are matched on THIS box at dispatch."
    );
    return 1;
  }
  const agent = dispatchAgentId(cfg);
  if (!agent) {
    err(
      "no dispatch agent configured for this machine — run `spor agent use <agent-id>` first.\n" +
        "The fleet scheduler keys published capabilities on this box's agent id (dispatch.agent)."
    );
    return 1;
  }
  // Re-probe THIS box before collapsing so the manual publish reflects current
  // reality — crucially the deterministic reachable_mcp:[spor] seed
  // (task-spor-mcp-reachability-deterministic-seed): we are remote-gated above,
  // so the spor MCP is reachable by construction (sporReachable: true). Without
  // this, a box whose .probed is empty/stale (no prior session-start) would
  // publish a caps set MISSING the spor seed, and an `mcp:[spor]` profile would
  // then fail to host-match it (issue-spor-capabilities-publish-manual-no-spor-
  // seed). Mirrors the session-start auto-publish: probe with sporReachable,
  // then merge the fresh probe over the in-memory config (loaded before the
  // probe wrote) so the two publish paths agree byte-for-byte. The probe is
  // best-effort — on failure we fall back to the in-memory config below.
  const rawCap = cfg.get("dispatch.capabilities", {}) || {};
  let probed = null;
  try {
    probed = u.probeCapabilities(cfg.userConfigHome(), { sporReachable: true, cfg });
  } catch {
    /* probe is best-effort; publish what the cascade already holds */
  }
  const eff = sat.effectiveCapabilities(probed ? { ...rawCap, probed } : rawCap);
  const r = await remote.post(cfg, `/v1/agents/${encodeURIComponent(agent)}/capabilities`, eff, { timeoutMs: 6000 });
  if (r.transport) {
    err(`could not reach the server: ${r.error}`);
    return 1;
  }
  if (r.status === 404) {
    err(`publish refused (404): no such agent '${agent}', or this server has no capability surface deployed.`);
    return 1;
  }
  if (r.status === 403) {
    err(`publish forbidden (403): you must OWN '${agent}' to publish its capabilities (the owned-by edge).`);
    return 1;
  }
  if (!r.ok) {
    const code = r.json && r.json.error && r.json.error.code;
    const msg = r.json && r.json.error && r.json.error.message;
    err(`publish failed: HTTP ${r.status}${code ? ` (${code})` : ""}${msg ? ` — ${msg}` : ""}`);
    return 1;
  }
  if (json) {
    out(JSON.stringify(r.json, null, 2));
    return 0;
  }
  const c = (r.json && r.json.capabilities) || {};
  out(`published ${agent} to the fleet scheduler (${remote.base(cfg)})`);
  out(`  harnesses:     ${(c.harnesses || []).join(", ") || "(none)"}`);
  out(`  reachable_mcp: ${(c.reachable_mcp || []).join(", ") || "(none)"}`);
  out(`  skills:        ${(c.skills || []).length}`);
  out(`  plugins:       ${(c.plugins || []).join(", ") || "(none)"}`);
  if ((c.deny || []).length) out(`  deny:          ${c.deny.join(", ")}`);
  out(r.json && r.json.changed === false ? "  (caps unchanged — refreshed last-published time)" : "  (caps updated)");
  return 0;
}

// fleetAgentCapabilities — the client READER of one agent's published fleet
// capabilities (GET /v1/agents/{id}/capabilities, art-spor-remote-fleet-
// scheduler-shipped; task-spor-capabilities-read-agent-cli-verb). The read twin
// of `spor capabilities publish` (which POSTs the same endpoint). Returns the
// parsed { agent, capabilities, published_at, last_seen, published_by, session }
// on 200, or a FAIL-SOFT shape that never throws — { error } (transport / other
// non-2xx), { absent:true } (404 — unknown agent, nothing published, or no
// scheduler surface deployed), or { forbidden:true, message } (403 — readable
// only by the owner, the agent itself, or an admin; API.md §3). The forbidden
// shape stays DISTINCT from { error } so a denial reports as authorization, not a
// transport outage (mirroring fleetHostsForProfile, issue-spor-capabilities-
// hosts-403-misreported).
async function fleetAgentCapabilities(cfg, agentId) {
  const r = await remote.get(cfg, `/v1/agents/${encodeURIComponent(agentId)}/capabilities`, { timeoutMs: 6000 });
  if (r.transport) return { error: r.error };
  if (r.status === 404) return { absent: true };
  if (r.status === 403) {
    const msg = r.json && r.json.error && r.json.error.message;
    return { forbidden: true, message: msg || null };
  }
  if (!r.ok) {
    const code = r.json && r.json.error && r.json.error.code;
    const msg = r.json && r.json.error && r.json.error.message;
    return { error: `HTTP ${r.status}${code ? ` (${code})` : ""}${msg ? ` — ${msg}` : ""}` };
  }
  const j = r.json || {};
  return {
    agent: j.agent || agentId,
    capabilities: j.capabilities || {},
    published_at: j.published_at || null,
    last_seen: j.last_seen || null,
    published_by: j.published_by || null,
    published_by_name: j.published_by_name || null,
    session: j.session || null,
  };
}

// cmdCapabilitiesShow — `spor capabilities show <agent-id>`, the explicit READER
// over the fleet scheduler: what a SPECIFIC box advertised, without falling back
// to raw REST (task-spor-capabilities-read-agent-cli-verb). The read twin of
// `publish` (write) and the per-agent companion to `hosts` (profile→boxes).
// Remote-only; fail-soft. `me` resolves to this machine's configured
// dispatch.agent (the `--owner me` convention), letting you verify what the fleet
// actually stored for THIS box vs what `spor capabilities` computes locally.
async function cmdCapabilitiesShow(cfg, { agentId, json }) {
  if (!remote.isRemote(cfg)) {
    err(
      "spor capabilities show <agent-id> is remote-only — set a team server (SPOR_SERVER) first.\n" +
        "  In local mode there is no fleet; `spor capabilities` (no agent) shows THIS box's effective caps."
    );
    return 1;
  }
  let agent = agentId;
  if (agent === "me") {
    agent = dispatchAgentId(cfg);
    if (!agent) {
      err(
        "no dispatch agent configured for this machine — run `spor agent use <agent-id>` first,\n" +
          "  or pass an explicit agent id: spor capabilities show <agent-id>."
      );
      return 1;
    }
  }
  const res = await fleetAgentCapabilities(cfg, agent);
  if (res.error) {
    err(`could not reach the fleet scheduler: ${res.error}`);
    return 1;
  }
  if (res.forbidden) {
    err(
      `not authorized to read ${agent}'s published capabilities — readable by the owner, the agent itself, or an admin.` +
        (res.message ? `\n  (server: ${res.message})` : "")
    );
    return 1;
  }
  if (res.absent) {
    err(`no capabilities published for '${agent}' (no such agent, nothing published yet, or no fleet scheduler surface deployed).`);
    return 1;
  }
  if (json) {
    out(JSON.stringify(res, null, 2));
    return 0;
  }
  const c = res.capabilities || {};
  out(`${res.agent} — published capabilities (fleet: ${remote.base(cfg)})`);
  out(`  harnesses:     ${(c.harnesses || []).join(", ") || "(none)"}`);
  out(`  reachable_mcp: ${(c.reachable_mcp || []).join(", ") || "(none)"}`);
  out(`  skills:        ${(c.skills || []).length}`);
  out(`  plugins:       ${(c.plugins || []).join(", ") || "(none)"}`);
  if ((c.deny || []).length) out(`  deny:          ${c.deny.join(", ")}`);
  if (res.published_at) out(`  published_at:  ${res.published_at} (caps last changed)`);
  if (res.last_seen) out(`  last_seen:     ${res.last_seen} (last contact)`);
  if (res.published_by) out(`  published_by:  ${labelledPerson(res.published_by_name, res.published_by)}`);
  if (res.session) out(`  session:       ${res.session}`);
  return 0;
}

// Compact relative age from age_seconds (the scheduler's freshness/last-contact
// proxy) — "12s" / "3m" / "2h" / "5d". Second-precision, like the rest of Spor.
function relAge(sec) {
  if (sec == null || typeof sec !== "number" || !isFinite(sec)) return "?";
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// fleetHostsForProfile — the client CONSUMER of the remote fleet scheduler's
// host-match (GET /v1/profiles/{id}/hosts, art-spor-remote-fleet-scheduler-shipped;
// task-spor-fleet-scheduler-autoroute-dispatch). The server host-matches the
// profile against every box's published capabilities with the SAME pure
// satisfies() the client runs locally, so a re-route never substitutes a
// different profile (dec-spor-machine-profile-satisfiability, FORK B). Returns
// the parsed { profile, satisfiable, unsatisfiable, counts } on 200, or a
// FAIL-SOFT shape that never throws: { error } (transport / 4xx-5xx), { absent:true }
// (404 — unknown profile or no scheduler surface deployed), or { forbidden:true,
// message } (403 — host visibility is steward-scoped, so a member asking for a
// colleague's owner=person-X is denied; API.md §3). The forbidden shape is kept
// DISTINCT from { error } so a consumer reports an authorization denial as such,
// never as a transport outage (issue-spor-capabilities-hosts-403-misreported).
// `owner` scopes to one person's boxes ('me'/'person-X'); `maxAge` ('30m'/'12h'/
// '7d'/ms) demotes staler publishes to unsatisfiable.
async function fleetHostsForProfile(cfg, profileId, { owner, maxAge } = {}) {
  const qs = [];
  if (owner) qs.push(`owner=${encodeURIComponent(owner)}`);
  if (maxAge) qs.push(`max_age=${encodeURIComponent(maxAge)}`);
  const q = qs.length ? `?${qs.join("&")}` : "";
  const r = await remote.get(cfg, `/v1/profiles/${encodeURIComponent(profileId)}/hosts${q}`, { timeoutMs: 6000 });
  if (r.transport) return { error: r.error };
  if (r.status === 404) return { absent: true };
  if (r.status === 403) {
    const msg = r.json && r.json.error && r.json.error.message;
    return { forbidden: true, message: msg || null };
  }
  if (!r.ok) {
    const code = r.json && r.json.error && r.json.error.code;
    const msg = r.json && r.json.error && r.json.error.message;
    return { error: `HTTP ${r.status}${code ? ` (${code})` : ""}${msg ? ` — ${msg}` : ""}` };
  }
  const j = r.json || {};
  return {
    profile: j.profile || profileId,
    satisfiable: Array.isArray(j.satisfiable) ? j.satisfiable : [],
    unsatisfiable: Array.isArray(j.unsatisfiable) ? j.unsatisfiable : [],
    counts: j.counts || null,
  };
}

// reportFleetHosts — the dispatch-refusal CONSUMER. On a FORK B refusal (this box
// can't satisfy the resolved profile), turn the dead-end "re-route somewhere"
// hint into an actionable one: NAME the boxes that satisfy THIS exact profile
// (re-route there), or — when none can — say so and escalate to the owner.
// Prints to stderr (it's part of the refusal). Returns true when it printed a
// scheduler-derived verdict, false to let the caller fall back to the generic
// hint (an unreachable / undeployed / unknown-profile scheduler — fail-soft, so
// the refusal still works offline and local mode stays byte-identical).
async function reportFleetHosts(cfg, profileId) {
  let res;
  try {
    res = await fleetHostsForProfile(cfg, profileId);
  } catch {
    return false;
  }
  if (!res || res.absent) return false; // unknown profile / no surface — generic hint fits better
  if (res.forbidden) {
    err(`  (not authorized to list fleet hosts for ${profileId} — host visibility is steward-scoped; falling back to a generic re-route hint)`);
    return false;
  }
  if (res.error) {
    err(`  (fleet scheduler unavailable: ${res.error} — falling back to a generic re-route hint)`);
    return false;
  }
  const ok = res.satisfiable || [];
  if (ok.length) {
    err(`  the assignment is unchanged. Re-route to a fleet host that satisfies ${res.profile} (freshest first):`);
    for (const h of ok.slice(0, 8)) {
      const ownerLabel = labelledPerson(h.owner_name, h.owner);
      const meta = [ownerLabel, `${relAge(h.age_seconds)} ago`].filter(Boolean).join(", ");
      err(`    - ${h.agent}${meta ? ` (${meta})` : ""}`);
    }
    if (ok.length > 8) err(`    … and ${ok.length - 8} more`);
    err(`  dispatch from one of those boxes — it runs THIS profile, never a substitute.`);
    return true;
  }
  // No host satisfies it — escalate (FORK B), don't downgrade.
  const checked = (res.unsatisfiable || []).length;
  err(`  NO fleet host currently satisfies ${res.profile} — escalate to the owner.`);
  err(`  (${checked} box(es) checked; none satisfy it. The assignment is unchanged — never substituted.)`);
  return true;
}

// cmdCapabilitiesHosts — `spor capabilities hosts <profile-id>`, the explicit
// CONSUMER verb over the fleet scheduler host-match (the standalone twin of the
// auto-reroute hint dispatch prints). Lists re-route targets (satisfiable,
// freshest first) and the boxes that can't run it WITH the matcher's reasons.
// Remote-only; fail-soft.
async function cmdCapabilitiesHosts(cfg, { profileId, owner, maxAge, json }) {
  if (!remote.isRemote(cfg)) {
    err(
      "spor capabilities hosts is remote-only — set a team server (SPOR_SERVER) first.\n" +
        "In local mode there is no fleet to match against; capabilities are matched on THIS box at dispatch."
    );
    return 1;
  }
  if (!profileId) {
    err("usage: spor capabilities hosts <profile-id> [--owner me|person-X] [--max-age 30m|12h|7d] [--json]");
    return 1;
  }
  const res = await fleetHostsForProfile(cfg, profileId, { owner, maxAge });
  if (res.forbidden) {
    const target = owner && owner !== "me" ? `${owner}'s boxes` : "another member's boxes";
    err(
      `not authorized to view ${target} — fleet host visibility is steward-scoped.\n` +
        "  try --owner me to see your own boxes, or ask an admin (a steward) to view the wider fleet." +
        (res.message ? `\n  (server: ${res.message})` : "")
    );
    return 1;
  }
  if (res.error) {
    err(`could not reach the fleet scheduler: ${res.error}`);
    return 1;
  }
  if (res.absent) {
    err(`no such profile '${profileId}', or this server has no fleet scheduler surface deployed.`);
    return 1;
  }
  if (json) {
    out(JSON.stringify(res, null, 2));
    return 0;
  }
  const ok = res.satisfiable || [];
  const no = res.unsatisfiable || [];
  out(`profile ${res.profile} — ${ok.length} satisfiable / ${no.length} not (fleet: ${remote.base(cfg)})`);
  if (ok.length) {
    out("satisfiable (re-route targets, freshest first):");
    for (const h of ok) {
      const ownerLabel = labelledPerson(h.owner_name, h.owner);
      const meta = [ownerLabel, `${relAge(h.age_seconds)} ago`].filter(Boolean).join(", ");
      out(`  ✓ ${h.agent}${meta ? ` (${meta})` : ""}`);
    }
  } else {
    out("satisfiable: (none — escalate to the owner; never substitute a different profile)");
  }
  if (no.length) {
    out("unsatisfiable:");
    for (const h of no) {
      const ownerLabel = labelledPerson(h.owner_name, h.owner);
      const meta = [ownerLabel, `${relAge(h.age_seconds)} ago`].filter(Boolean).join(", ");
      out(`  ✗ ${h.agent}${meta ? ` (${meta})` : ""}`);
      for (const reason of h.reasons || []) out(`      - ${reason}`);
    }
  }
  return 0;
}

function version() {
  try {
    return require(path.join(ROOT, "package.json")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ---------------------------------------------------------------------------
// The command table — the single source of truth for dispatch, parsing, and help
// ---------------------------------------------------------------------------
// Each entry declares its group (for the top-level listing), a positional usage
// hint (`args`), a one-line `summary`, a longer `help` body, an `options` map in
// util.parseArgs shape (each carrying a help-only `desc`/`value`), optional
// `examples`, and `aliases`. `parse` picks the front-door behavior:
//   "strict" — central util.parseArgs validates flags (unknown-flag errors with
//              a suggestion) and the run() gets { values, positionals }.
//   "raw"    — run() gets the raw argv array; for commands that own their parsing
//              (subcommands like token/repos), forward open --PARAM sets (lens),
//              or must stay byte-identical passthrough to lib/*.js (compile,
//              validate, next-local, cost). norm-cc-byte-identical-refactor.
//   "meta"   — listing-only (help/version are intercepted in main before dispatch).
const SCOPE_OPT = { type: "string", value: "user|repo", desc: "where to write — 'user' (default) or 'repo' (this checkout)" };
const PRINT_OPT = { type: "boolean", desc: "dry run — show what would change, write nothing" };
const DRYRUN_OPT = { type: "boolean", desc: "alias for --print" };

const COMMANDS = {
  // --- Getting started ---
  init: {
    group: "Getting started", parse: "strict", args: "", options: {},
    summary: "create the local graph home (nodes/, git, .gitignore)",
    help:
      "Idempotently create the local graph home: a nodes/ directory, a git repo\n" +
      "to version it, and a .gitignore for machine-local state. Safe to re-run —\n" +
      "an existing graph is reported, never clobbered.",
    run: (cfg) => cmdInit(cfg),
  },
  install: {
    group: "Getting started", parse: "strict", args: "[host...]", aliases: ["setup"],
    summary: "wire spor into an agent (claude codex gemini opencode copilot cursor)",
    help:
      "Wire the spor hooks/plugin into one or more host agents. With no host, lists\n" +
      "the hosts detected on this machine and touches nothing. Claude Code is wired\n" +
      "via its plugin CLI; the others receive a merged hooks manifest.\n\n" +
      "--server/--token also persist remote-graph credentials to your user config.\n\n" +
      "--mcp additionally auto-writes the per-host MCP server config (codex's\n" +
      "~/.codex/config.toml [mcp_servers.spor]; gemini/opencode/copilot's JSON\n" +
      "mcpServers entry) — merged into any existing file, idempotent — and runs\n" +
      "agents-md to populate AGENTS.md, so one command finishes the setup that\n" +
      "otherwise needed the manual recipe in each adapter's README. Needs a\n" +
      "configured server (--server/--token or 'spor join').",
    options: {
      scope: SCOPE_OPT,
      all: { type: "boolean", desc: "install into every detected host" },
      print: PRINT_OPT,
      "dry-run": DRYRUN_OPT,
      server: { type: "string", value: "url", desc: "persist a team-graph server URL to user config" },
      token: { type: "string", value: "tok", desc: "persist an auth token to user config" },
      mcp: { type: "boolean", desc: "also auto-write per-host MCP config + AGENTS.md (codex/gemini/opencode/copilot)" },
    },
    examples: ["spor install claude", "spor install codex gemini --scope repo", "spor install --all --print", "spor install codex --mcp"],
    run: (cfg, p) => cmdInstall(cfg, p),
  },
  upgrade: {
    group: "Getting started", parse: "strict", args: "[host...]", aliases: ["update"],
    summary: "refresh wired spor to the installed package version (after an npm bump)",
    help:
      "Refresh wired hosts to the package version on disk. A bumped npm package does\n" +
      "not change what an agent already loaded — Claude Code runs its own cached copy\n" +
      "until 'plugin update' swaps it. With no host, refreshes every detected host\n" +
      "that has spor wired. Also flags a newer release published to npm.",
    options: { scope: SCOPE_OPT, print: PRINT_OPT, "dry-run": DRYRUN_OPT, "no-net": { type: "boolean", desc: "skip the npm 'newer version published' check" } },
    examples: ["spor upgrade", "spor upgrade claude --print"],
    run: (cfg, p) => cmdUpgrade(cfg, p),
  },
  status: {
    group: "Getting started", parse: "strict", args: "",
    options: {
      quiet: { type: "boolean", short: "q", desc: "skip the remote health probe + identity lookup (local fields only, no network round-trip)" },
    },
    summary: "resolved mode, graph, project, identity, health",
    help: "Print the resolved mode (local/remote), graph home, project slug, identity,\nand a health probe. In local mode it also warns of a split-brain claude.ai\nSpor MCP connector; it always surfaces the Node prerequisite line.\n\n--quiet skips the remote health probe and identity lookup (each a network\nround-trip, the health probe up to 6s) — use it when a caller only needs the\nlocally-resolved mode/project/graph fields, e.g. a skill reading back the\nproject slug.",
    examples: ["spor status", "spor status --quiet"],
    run: (cfg, p) => cmdStatus(cfg, p),
  },
  join: {
    group: "Getting started", parse: "strict", args: "[url] <token>",
    summary: "add an org-scoped credential (paste a token; hosted default)",
    help:
      "ADD a team-graph credential to the multi-tenant store (~/.spor/auth/\n" +
      "credentials.json), keyed by (server, org), and confirm it against /v1/me. A\n" +
      "person in N orgs holds N credentials; join NEVER overwrites a sibling tenant\n" +
      "(dec-spor-client-cli-mode-tenant-resolution). The org is read from the token\n" +
      "(JWT claim) or --org. The URL is optional: omit it to onboard to the hosted\n" +
      "Spor service (https://api.sporhq.io) — a token-shaped first positional\n" +
      "(spor_pat_…) is read as the token, so 'spor join <token>' works; an explicit\n" +
      "URL still wins. For interactive sign-in (no pasted token) use 'spor auth\n" +
      "login' (device-code). The URL/token are positional or --server/--token.",
    options: {
      server: { type: "string", value: "url", desc: "server URL (else the first positional; default https://api.sporhq.io)" },
      token: { type: "string", value: "tok", desc: "auth token (else the trailing positional)" },
    },
    examples: ["spor join spor_pat_abc123", "spor join https://graph.example.com spor_pat_abc123 --org acme"],
    run: (cfg, p) => cmdJoin(cfg, p),
  },
  auth: {
    group: "Getting started", parse: "raw",
    args: "<login|list|switch|whoami|logout>",
    summary: "sign in & manage org-scoped credentials (multi-tenant)",
    help:
      "Acquire and manage org-scoped Spor credentials. Server tokens are org-scoped,\n" +
      "so a person in N orgs holds N credentials in the store (~/.spor/auth/\n" +
      "credentials.json); these verbs populate and select within it and never clobber\n" +
      "a sibling tenant (dec-spor-cli-auth-device-grant-front-door).\n\n" +
      "  spor auth login               interactive sign-in; DEFAULT = the RFC 8628\n" +
      "                                device authorization grant (works headless/SSH:\n" +
      "                                prints a code + URL, you approve in any browser)\n" +
      "      --server <url>            the Spor front door (else SPOR_SERVER / active)\n" +
      "      --org <slug>              label/select the org for the stored credential\n" +
      "      --web                     localhost-loopback variant (auth code + PKCE;\n" +
      "                                falls back to device-code if unsupported)\n" +
      "      --all                     one token per org membership (needs the server\n" +
      "                                membership endpoint; falls back to one org)\n" +
      "      --no-open                 do not auto-open a browser\n" +
      "      <url> <token>             paste path — store a pre-minted PAT (like join)\n" +
      "  spor auth list                tenants + live org membership, active, token health\n" +
      "  spor auth switch <org>        set the active (default) tenant\n" +
      "  spor auth whoami [--all]      identity for the active tenant (or all of them)\n" +
      "  spor auth logout [<org>]      clear one tenant, the active one, or --all\n\n" +
      "Flat 'login'/'whoami'/'join' remain as aliases (dec-cc-spor-rename-compat-dual-read).\n" +
      "The non-interactive / CI path stays SPOR_TOKEN.",
    examples: [
      "spor auth login --server https://graph.example.com",
      "spor auth switch acme",
      "spor auth whoami --all",
      "spor auth logout acme",
    ],
    run: (cfg, args) => cmdAuth(cfg, args),
  },
  login: {
    group: "Getting started", parse: "raw", args: "[--web] [--server <url>] [--org <slug>]",
    summary: "interactive sign-in (device-code) — alias of 'auth login'",
    help:
      "Interactive sign-in, defaulting to the RFC 8628 device authorization grant —\n" +
      "an alias of 'spor auth login' (see that for flags). 'spor login <url> <token>'\n" +
      "still works as the paste path. The non-interactive path stays SPOR_TOKEN.",
    examples: ["spor login --server https://graph.example.com", "spor login https://graph.example.com tok_abc123"],
    run: (cfg, args) => cmdAuthLogin(cfg, args),
  },
  migrate: {
    group: "Getting started", parse: "strict", args: "<url>", aliases: ["push"],
    summary: "push the local graph to a remote you own (solo-remote)",
    help: "Commit the local graph home and push it to a git remote you own (e.g. a\nprivate GitHub repo). The URL is remembered as 'origin', so later pushes need\nno argument. Pure git plumbing — no server route is involved.",
    options: {},
    examples: ["spor migrate git@github.com:you/my-graph.git", "spor push"],
    run: (cfg, p) => cmdMigrate(cfg, p),
  },
  whoami: {
    group: "Getting started", parse: "raw", args: "[--all]",
    summary: "who the team graph thinks you are (remote)",
    help:
      "Echo the identity the server binds to your token for the ACTIVE tenant (remote\n" +
      "mode). In local mode it explains there is no server identity. --all enumerates\n" +
      "the identity of every stored tenant. Alias of 'spor auth whoami'.",
    examples: ["spor whoami", "spor whoami --all"],
    run: (cfg, args) => cmdAuthWhoami(cfg, args),
  },
  person: {
    group: "Getting started", parse: "raw",
    args: "create [<name>] [--email <e>] [--id person-x] | list",
    summary: "create your local person node (the $viewer identity anchor)",
    help:
      "Create the local `type: person` node the queue binds your git identity to —\n" +
      "the LOCAL-mode, self-serve counterpart to the remote/admin-gated 'spor invite'.\n" +
      "An onboarding prerequisite: `spor agent create` needs a person to own the agent,\n" +
      "and the queue's per-viewer mutes resolve through it.\n\n" +
      "  spor person create [<name>]   write the node, seeding title/email from the graph\n" +
      "                                home's git identity (git config user.name/user.email)\n" +
      "      --email <e>               override the seeded email (the $viewer binding key)\n" +
      "      --name <n>                override the seeded name (else the leading positional)\n" +
      "      --id person-x             explicit node id (default opaque person-<hash(email)>)\n" +
      "  spor person list              list person nodes, marking your git-identity binding\n\n" +
      "Idempotent: a re-run that finds a node already bound to your git identity reports\n" +
      "it and exits 0. Local only — in remote mode your person node is server-managed\n" +
      "('spor whoami'); create teammates with 'spor invite' (admin).",
    examples: ["spor person create", "spor person create 'Jo Diaz' --email jo@x.io", "spor person list"],
    run: (cfg, args) => cmdPerson(cfg, args),
  },

  // --- Team admin ---
  invite: {
    group: "Team admin (remote, admin token)", parse: "strict",
    args: "--person <id> | --name <n> --email <e>",
    summary: "mint a teammate token (creates the person node if needed)",
    help:
      "Mint a person-bound token and print a paste-ready 'spor join' line. Remote +\n" +
      "admin only. Pass --person to bind an existing person node, or --name/--email\n" +
      "to create the node first.",
    options: {
      person: { type: "string", value: "id", desc: "bind to an existing person node" },
      name: { type: "string", value: "name", desc: "create a person node with this name" },
      email: { type: "string", value: "email", desc: "the new person's email" },
      id: { type: "string", value: "id", desc: "explicit id for the created person node" },
      expires: { type: "string", value: "Nd", desc: "token lifetime, e.g. 30d" },
    },
    examples: ["spor invite --person person-jo", "spor invite --name 'Jo Diaz' --email jo@x.io --expires 30d"],
    run: (cfg, p) => cmdInvite(cfg, p),
  },
  token: {
    group: "Getting started", parse: "raw",
    args: "create [--expires <Nd>] [--label <l>] | list [--all] | revoke <prefix> [--all]",
    summary: "self-serve personal access tokens (create, list, revoke your own)",
    help:
      "Create, list, and revoke your OWN personal access tokens (spor_pat_) for CI and\n" +
      "headless use — the self-serve twin of `spor invite` (which mints for others). Every\n" +
      "verb is caller-scoped over /v1/me/tokens and needs a bound person identity (check\n" +
      "'spor whoami'). Remote only.\n\n" +
      "  spor token create             mint a PAT bound to you, shown in plaintext ONCE\n" +
      "      --expires <Nd|ISO>        lifetime, e.g. 90d (default + max: 1 year)\n" +
      "      --label <text>            a note to identify it in the listing\n" +
      "  spor token list               your PATs (hash prefix, label, expiry)\n" +
      "      --all                     the whole team's tokens (admin; = spor admin token list)\n" +
      "  spor token revoke <prefix>    revoke one of YOUR PATs by hash prefix\n" +
      "      --all                     revoke ANY token by prefix (admin; = spor admin token revoke)",
    examples: ["spor token create --expires 90d --label ci", "spor token list", "spor token revoke a1b2c3"],
    run: (cfg, args) => cmdToken(cfg, args),
  },
  agent: {
    group: "Dispatch (background agents)", parse: "raw", args: "create <label> [--owner <id>] [--pubkey <fp>] | list | use <agent-id> | token <agent-id> [list|revoke <prefix>]",
    summary: "person-owned automation principals (dispatch identity, standing PATs)",
    help:
      "Create and list agents — first-class `type: agent` nodes owned by a person\n" +
      "(dec-spor-agent-identity-nodes). A dispatched session runs AS its agent, so its\n" +
      "writes read \"agent on behalf of person\" rather than person-direct. One durable\n" +
      "agent per machine/install, reused across dispatches.\n\n" +
      "  spor agent create <label>     create the agent + its owned-by edge to a person\n" +
      "      --owner <person-id>       create it for ANOTHER person (admin); without it\n" +
      "                                the agent is owned by YOU (self-serve). local mode:\n" +
      "                                defaults to the sole person node, else required\n" +
      "      --pubkey <fingerprint>    record a public-key fingerprint (forward-compat,\n" +
      "                                unenforced — may be omitted)\n" +
      "  spor agent list               list agents and their owners\n" +
      "  spor agent use <agent-id>     make it THIS machine's default dispatch identity\n" +
      "                                (writes dispatch.agent to your user config; pass\n" +
      "                                --clear to drop it — dispatch then refuses remote\n" +
      "                                launches unless --allow-person-token opts back into\n" +
      "                                the person-scoped fallback).\n" +
      "                                A bare label (no 'agent-' prefix) also resolves\n" +
      "                                against your own agents ('spor agent list')\n" +
      "                                before falling back to the prefix-hint error.\n" +
      "  spor agent token <agent-id>   mint a long-lived STANDING PAT for the agent —\n" +
      "                                the SPOR_TOKEN a headless agent (Claude Code on\n" +
      "                                the Web) runs under; shown once\n" +
      "      --expires <Nd|date>       shorten its lifetime (default + max 1 year)\n" +
      "      --label <l>               tag it for the listing\n" +
      "  spor agent token <id> list    list the agent's standing PATs\n" +
      "  spor agent token <id> revoke <prefix>   revoke one by hash prefix\n\n" +
      "'use' is a local config write, not a graph write — it sets which agent\n" +
      "`spor dispatch` runs as by default (override one dispatch with 'dispatch --as').\n" +
      "Create runs self-serve (POST /v1/agents, owner = you; --owner uses the admin\n" +
      "POST /v1/admin/agents); local mode writes the node + owned-by edge to the graph\n" +
      "home. 'token' is remote-only (owner-gated standing mode of POST /v1/agents/<id>/token).",
    examples: ["spor agent create anthony-cc-web", "spor agent token agent-anthony-cc-web --label cc-web", "spor agent use agent-anthony-laptop"],
    run: (cfg, args) => cmdAgent(cfg, args),
  },
  admin: {
    group: "Team admin (remote, admin token)", parse: "raw", args: "gardener [--json] | token list|revoke <prefix>",
    summary: "ops-facing operations (gardener sweep, team token admin)",
    help:
      "Ops-facing operations, kept apart from everyday graph work — the home for\n" +
      "stewards-gated ops. Remote only: the server owns these.\n\n" +
      "  spor admin gardener           run a gardener sweep now (POST /v1/gardener)\n" +
      "      --json                    print the raw {checked, filed, resolved, skipped} envelope\n" +
      "  spor admin token list         the whole team's tokens (= spor token list --all)\n" +
      "  spor admin token revoke <p>   revoke ANY token by hash prefix (= spor token revoke <p> --all)\n\n" +
      "The sweep files its observations as `type: finding` queue items\n" +
      "(dec-cc-gardener-files-findings) and resolves its own findings whose condition\n" +
      "has cleared — it never mutates human-authored nodes. It can examine the whole\n" +
      "graph, so an on-demand run may take a little while. The endpoint is\n" +
      "authenticated but not admin-gated server-side today, so any valid team token\n" +
      "can run it; a 403 (should a deployment add the gate) means admin privilege is\n" +
      "required — check 'spor whoami' (is_admin). The token surface IS admin-gated:\n" +
      "everyday self-serve token management is 'spor token' (your own PATs).",
    examples: ["spor admin gardener", "spor admin token list", "spor admin token revoke a1b2c3"],
    run: (cfg, args) => cmdAdmin(cfg, args),
  },

  // --- Graph ---
  add: {
    group: "Graph", parse: "strict", args: '"<text>"', aliases: ["capture"],
    summary: "capture a node (local: typed file; remote: /v1/capture)",
    help:
      "Capture a node from prose. In remote mode the server's ingestion model types\n" +
      "and links it; in local mode a well-formed, validated node file is written so\n" +
      "you never hand-author frontmatter. --type/--title/--id apply to local mode.\n\n" +
      "Capture context (both modes): --during links to the work this was discovered\n" +
      "during (a derived-from edge). --blocks <id> + --needed-by <date> declare a\n" +
      "cross-project dependency — set --project to the SERVING project (who must do\n" +
      "the work) and it surfaces in their queue, ramping urgency as the date nears.\n\n" +
      "--dedupe-key <key> (remote) names this capture so a re-run of the same logical\n" +
      "capture replays the original instead of filing a duplicate: it becomes the\n" +
      "request's idempotency key, and within the server's idempotency window a repeat\n" +
      "returns the original node ids and prints '(idempotent replay)'. Give it a key\n" +
      "that is stable for the thing being captured and unique across different things\n" +
      "(e.g. 'cron-monitor.harvest-stall.2026-08-22T06-34-14Z'); it is never derived\n" +
      "from the text. Ignored in local mode (no transport race to guard).",
    options: {
      type: { type: "string", value: "T", desc: "node type (local only; default: task)" },
      title: { type: "string", value: "...", desc: "title (default: first 10 words)" },
      project: { type: "string", value: "S", desc: "project slug (default: inferred from cwd; the SERVING project for a cross-project dependency)" },
      id: { type: "string", value: "id", desc: "explicit node id (local only)" },
      during: { type: "string", value: "id", desc: "node this was discovered during (derived-from edge)" },
      blocks: { type: "string", value: "id", desc: "node id this work blocks (cross-project dependency; target must exist)" },
      "needed-by": { type: "string", value: "date", desc: "YYYY-MM-DD deadline that ramps queue urgency (pairs with --blocks)" },
      "dedupe-key": { type: "string", value: "key", desc: "caller-chosen idempotency key: a repeat within the server's window replays the original capture instead of duplicating it (remote only)" },
    },
    examples: [
      'spor add "Cache tf-idf norms across compiles for speed" --type task',
      'spor add "Platform must expose a token-rotation hook" --project platform --blocks task-my-initiative --needed-by 2026-07-15',
      'spor add "harvest-usage-traces has failed 3 ticks running" --dedupe-key cron-monitor.harvest-failure.2026-08-22T06-34-14Z',
    ],
    run: (cfg, p) => cmdAdd(cfg, p),
  },
  ask: {
    group: "Graph", parse: "strict", args: '"<question>"', aliases: ["question"],
    summary: "file a question the graph can't answer (local: question node; remote: /v1/questions)",
    help:
      "File a question the graph could not answer, so it becomes a routed node instead\n" +
      "of evaporating when the digest gate comes back empty. Remote mode POSTs\n" +
      "/v1/questions (ask_question's REST twin): the server routes the question to the\n" +
      "steward of the closest node in its relevance neighborhood, leaves it unrouted\n" +
      "(visible to everyone) when none matches, and attributes it to your token. Local\n" +
      "mode writes an open, queueable question node file so a solo user's question\n" +
      "still surfaces in 'spor next'.\n\n" +
      "--mention names a node the question is about (repeatable); routing considers\n" +
      "mentions first, and locally each becomes a mentions edge. --project overrides\n" +
      "the derived project — pass it for a mention-less question whose neighborhood is\n" +
      "empty. --title/--id apply to the local node.\n\n" +
      "Answer a question by writing a node with an answers edge to it, then\n" +
      "'spor set-status <id> answered'.",
    options: {
      title: { type: "string", value: "...", desc: "short question title (default: first 10 words)" },
      mention: { type: "string", value: "id", desc: "a node the question is about (repeatable; routing weighs these first)", multiple: true },
      project: { type: "string", value: "S", desc: "override the derived project (for a mention-less question)" },
      id: { type: "string", value: "id", desc: "explicit node id (local only)" },
    },
    examples: [
      'spor ask "Why does the gardener skip resident schema nodes?"',
      'spor ask "Did the OAuth phase B token-rotation hook land?" --mention dec-cc-authz-rebac-fga',
      'spor ask "Where do tenant OTEL spans get dropped?" --project spor-server',
    ],
    run: (cfg, p) => cmdAsk(cfg, p),
  },
  drain: {
    group: "Graph", parse: "strict", args: "", aliases: ["sync"],
    summary: "flush spooled captures to the team server (remote)",
    help:
      "Ship the fail-open capture spool (graphHome/outbox) to the team server — the\n" +
      "manual trigger of the same drain a Claude Code session runs at start, for\n" +
      "pure-CLI users who never open a session and so have no other drain trigger.\n\n" +
      "When a remote `spor add` can't reach the server (down, or >30s ingestion) it\n" +
      "spools the capture to the outbox instead of losing it; this replays each one\n" +
      "to /v1/capture (or /v1/nodes). A SUCCESSFUL remote `spor add` also drains\n" +
      "opportunistically, so standalone CLI usage self-heals without this verb too.\n\n" +
      "Remote-only (local mode never spools — captures write straight to the graph).\n" +
      "Shipped files are removed; permanent 4xx rejects (e.g. a revoked token) move\n" +
      "to outbox/dead/ for inspection; transient failures stay spooled for the next\n" +
      "drain. Exits 1 only when nothing could ship (server unreachable).",
    options: {
      limit: { type: "string", value: "N", desc: "drain at most N files (default: all)" },
      timeout: { type: "string", value: "S", desc: "per-file budget in seconds (default: 30)" },
    },
    examples: ["spor drain", "spor drain --limit 10", "spor drain --timeout 10"],
    run: (cfg, p) => cmdDrain(cfg, p),
  },
  next: {
    group: "Graph", parse: "raw", args: "[--project S | --all-projects] [--type T] [--exclude-type T] [--limit N]", aliases: ["queue"],
    summary: "the decision queue (local: lib/queue; remote: /v1/queue)",
    help: "Show the ranked decision queue. Remote mode reads /v1/queue; local mode is a\nbyte-identical passthrough to lib/queue.js, so it also accepts that script's\nflags (--days, --no-front, --name-only, --nodes).\n\nSCOPE. --project accepts a repo slug (-> its home-project grouping union), a\nrepo-<slug> node id (-> that single repo), or a grouping id (-> the grouping\nunion); an unknown token warns and yields an empty queue. Pin a default scope\nfor both modes with the queue.project config key (SPOR_QUEUE_PROJECT or\n.spor.json {\"queue\":{\"project\":\"...\"}}); an explicit --project still wins.\n--all-projects (alias --all) widens to the whole-graph cross-project firehose,\ndropping the cwd/pinned default scope (an explicit --project still wins over it).\n\nPAGE SIZE. --limit N caps the queue at N items (default 20, both modes);\n--limit 0 shows ALL. Remote mode pages the server at 100 items/request, so\n--limit 0 (or any N>100) is assembled by walking offset across pages; the\naggregate counts always describe the full ranked set regardless of the page.\n\nNODE TYPES. --type/--exclude-type whitelist/blacklist node types from the\nranking; both are repeatable and comma-splittable (--type task,issue). Given\nboth, the include set is narrowed and then the excludes are removed (exclude\nwins on overlap). They compose with --project/--all-projects.\n\nIN-FLIGHT. --json stamps each item with an `in_flight` flag (and a `dispatched`\nagent summary when true) by cross-referencing live background agents from\n`claude agents --json` — `spor dispatch` names each agent after its node id, so\nan active agent on a queued item is detectable without model guidance.\n--hide-dispatched drops the items that already have an agent in flight. Both are\nclient-side (the server can't see local agents) and fail soft when the claude\nbinary is absent (every item then reads in_flight:false).",
    options: {
      project: { type: "string", value: "S", desc: "scope to a project slug (default: queue.project config, else inferred)" },
      "all-projects": { type: "boolean", desc: "cross-project firehose — drop the default project scope (alias --all)" },
      type: { type: "string", value: "T", desc: "include only these node types (repeatable, comma-ok)" },
      "exclude-type": { type: "string", value: "T", desc: "exclude these node types from the ranking (repeatable, comma-ok)" },
      limit: { type: "string", value: "N", desc: "max items to show (default 20; 0 = all)" },
      json: { type: "boolean", desc: "machine-readable JSON output (adds the in_flight flag per item)" },
      "hide-dispatched": { type: "boolean", desc: "drop items that already have a background agent in flight" },
    },
    examples: ["spor next", "spor next --limit 50", "spor next --limit 0", "spor next --json", "spor next --json --hide-dispatched", "spor next --all-projects --type task,issue", "spor next --exclude-type capture-pending"],
    run: (cfg, args) => cmdNext(cfg, args),
  },
  get: {
    group: "Graph", parse: "strict", args: "<id> [--json]",
    options: {
      json: { type: "boolean", desc: "structured JSON: frontmatter, edges (inbound+outbound), body, revision" },
    },
    summary: "a node by id (local: file; remote: /v1/nodes/<id>)",
    help:
      "Print one node's raw markdown by id. Remote mode reads /v1/nodes/<id>; local\n" +
      "mode reads the node file. A missing node exits 1.\n\n" +
      "--json emits a structured object — {id, frontmatter, body, edges:{outbound,\n" +
      "inbound}, revision} — so scripts and tooling stop scraping markdown\n" +
      "frontmatter. `revision` is the git blob SHA an update sends; inbound edges are\n" +
      "gathered by scanning the whole graph (remote fetches GET /v1/export), so --json\n" +
      "is heavier than the plain read. Mode-symmetric (norm-spor-cli-mode-parity).",
    examples: ["spor get dec-cc-zero-dep-client", "spor get dec-cc-zero-dep-client --json"],
    run: (cfg, p) => cmdGet(cfg, p),
  },
  "put-node": {
    group: "Graph", parse: "strict", args: "[<file>|-]",
    summary: "write a full node markdown file (local validated write; remote: /v1/nodes)",
    help:
      "Create, skip, or update one complete node markdown file (frontmatter + body)\n" +
      "through the same validated full-node write path as MCP put_node / REST\n" +
      "POST /v1/nodes. With no file, or with '-', reads the node markdown from stdin.\n\n" +
      "Collision policy is explicit: --if-exists error (default) rejects an existing\n" +
      "id, --if-exists skip no-ops on collision, and --if-exists update replaces an\n" +
      "existing node only when --revision matches the blob SHA you read earlier.\n" +
      "Get that revision with 'spor get <id> --json'; re-read and retry on conflict.\n\n" +
      "Remote mode sends one-entry batch put_node to /v1/nodes, so server attribution,\n" +
      "schema transition gates, edge normalization, and validation all apply. Local\n" +
      "mode writes nodes/<id>.md after parsing and validating the candidate against a\n" +
      "temporary graph view, so a malformed full node never lands on disk.",
    options: {
      "if-exists": { type: "string", value: "error|skip|update", desc: "collision policy (default: error)" },
      revision: { type: "string", value: "sha", desc: "required with --if-exists update; from 'spor get <id> --json'" },
      json: { type: "boolean", desc: "machine-readable result envelope" },
    },
    examples: [
      "spor put-node ./nodes/dec-x.md",
      "spor get dec-x --json",
      "spor put-node ./dec-x.md --if-exists update --revision <blob-sha>",
      "cat ./task-new.md | spor put-node --if-exists error",
    ],
    run: (cfg, p) => cmdPutNode(cfg, p),
  },
  blame: {
    group: "Graph", parse: "strict", args: "<sha> [--repo <slug>]", aliases: ["commits"],
    summary: "which nodes reference a commit (local: graph scan; remote: /v1/commits/<sha>)",
    help:
      "Reverse-lookup a git commit to the decision/task/issue nodes that reference it\n" +
      "in their commits: field — blame a line, get the why, without curl. The mirror\n" +
      "of commit-linking (which records node->commit); this is commit->node.\n\n" +
      "The sha is 7-40 hex chars, abbreviated or full (matched prefix-aware against\n" +
      "the stored shas). --repo scopes to one repo slug. An empty result is normal\n" +
      "(a commit linked to no node) and exits 0. Remote mode reads /v1/commits/<sha>;\n" +
      "local mode scans the graph home. --json emits {sha, repo?, matches}.",
    options: {
      repo: { type: "string", value: "slug", desc: "scope to one repo slug" },
      json: { type: "boolean", desc: "machine-readable JSON output" },
    },
    examples: ["spor blame b384469", "spor commits b384469 --repo spor", "spor blame b384469 --json"],
    run: (cfg, p) => cmdBlame(cfg, p),
  },
  history: {
    group: "Graph", parse: "strict", args: "<id> [<sha>] [--limit N]",
    summary: "a node's commit lineage (local: git log; remote: /v1/nodes/<id>/history)",
    help:
      "Show a single node's commit history — every revision's actor, time, and what\n" +
      "changed — as a `git log` projection over nodes/<id>.md. The frontmatter author\n" +
      "field re-stamps to the LAST editor on every write, so git history is the only\n" +
      "durable record of the full chain of editors.\n" +
      "\n" +
      "  spor history <id>          the ordered commit list, newest first\n" +
      "  spor history <id> <sha>    one revision's diff + change type\n" +
      "\n" +
      "A server-internal write (boot reconcile / migration) is labeled as such; a real\n" +
      "actor maps to its person node where one exists. Remote mode reads\n" +
      "/v1/nodes/<id>/history (the list) and /v1/nodes/<id>/history/<sha> (the diff);\n" +
      "local mode runs the same git-log projection over the graph home, so output\n" +
      "matches across modes.\n" +
      "\n" +
      "  --limit <N>     max revisions in the list (default 50, max 200)\n" +
      "  --content       with a <sha>, also print the full node at that revision\n" +
      "  --json          emit the raw envelope instead of the rendered view",
    options: {
      limit: { type: "string", value: "N", desc: "max revisions in the list (default 50, max 200)" },
      content: { type: "boolean", desc: "with a <sha>, also print the full node at that revision" },
      json: { type: "boolean", desc: "machine-readable JSON output" },
    },
    examples: [
      "spor history dec-cc-zero-dep-client",
      "spor history dec-cc-zero-dep-client --limit 10",
      "spor history dec-cc-zero-dep-client a1b2c3d --content",
    ],
    run: (cfg, p) => cmdHistory(cfg, p),
  },
  lens: {
    group: "Graph", parse: "raw", args: "[<id>]", aliases: ["render-lens"],
    summary: "render a saved view (remote)",
    help:
      "Render a saved lens (remote only — lenses render server-side). With no id,\n" +
      "lists the lens catalog; with an id, renders it. Any extra --PARAM VALUE flags\n" +
      "beyond --format/--json are forwarded to the lens as render parameters.",
    options: {
      format: { type: "string", value: "text|json", desc: "server rendering format (default: text)" },
      json: { type: "boolean", desc: "force JSON: the raw catalog / view tree" },
    },
    examples: ["spor lens", "spor lens lens-roadmap", "spor lens lens-roadmap --project spor"],
    run: (cfg, args) => cmdLens(cfg, args),
  },
  run: {
    group: "Graph", parse: "strict", args: "<workflow-id> [--inputs <json>] | status <run-id>",
    summary: "start a workflow run / inspect a run (remote)",
    help:
      "Start or inspect a workflow run — the shell twin of the run_workflow MCP tool.\n" +
      "Workflow execution runs server-side (the run engine lives in the engine half),\n" +
      "so this verb is remote only; local mode degrades with one line and no crash.\n\n" +
      "  spor run <workflow-id> [--inputs <json>]   start a run on an ACTIVE workflow\n" +
      "                                             (POST /v1/workflows/{id}/run)\n" +
      "  spor run status <run-id>                   inspect a run's state + per-step\n" +
      "                                             status (GET /v1/runs/{id})\n\n" +
      "--inputs is a JSON OBJECT supplying the workflow's ${inputs.x} values. Starting\n" +
      "a run only CREATES the workflow-run node and its initial step states — workers\n" +
      "then claim ready steps over the claim API; it never executes effects. The\n" +
      "workflow must already be active (a proposed one must be activated by a different\n" +
      "identity first — the self-approval ban), else the start is refused with the why.",
    options: {
      inputs: { type: "string", value: "json", desc: "JSON object of workflow inputs (${inputs.x} interpolation)" },
      json: { type: "boolean", desc: "machine-readable JSON output (the raw run record)" },
    },
    examples: [
      "spor run wf-release-pipeline",
      "spor run wf-release-pipeline --inputs '{\"ref\":\"v1.2.0\"}'",
      "spor run status run-release-pipeline-20260620",
    ],
    run: (cfg, p) => cmdRun(cfg, p),
  },
  share: {
    group: "Graph", parse: "strict", args: "<lens-id> [--expires <Nd>]",
    summary: "mint a shareable read-only view link (remote)",
    help:
      "Mint a signed, expiring, read-only render ticket for a lens or workspace node\n" +
      "and print the shareable view link — ready to paste to a teammate. The shell\n" +
      "front-door for POST /v1/lens/{id}/ticket.\n\n" +
      "Sharing replaced embedding the sharer's PAT in the URL\n" +
      "(dec-cc-lens-share-render-tickets): the ticket records YOU as the sharer, binds\n" +
      "the viewer to that recorded identity (the render shows a \"Viewing as\" banner),\n" +
      "and carries NO write scope — so a pasted link can never leak a write-capable\n" +
      "credential. Remote only: tickets are minted and signed server-side; local mode\n" +
      "degrades with one line and no crash.\n\n" +
      "--expires is \"<N>d\" or an ISO date (server default 7d, max 30d). Your token\n" +
      "must be bound to a person node (the recorded sharer), else the mint is refused.",
    options: {
      expires: { type: "string", value: "Nd", desc: "ticket lifetime: <N>d or an ISO date (default 7d, max 30d)" },
      json: { type: "boolean", desc: "machine-readable JSON output (the raw {ticket, url, ...} envelope)" },
    },
    examples: ["spor share lens-roadmap", "spor share lens-roadmap --expires 14d", "spor share workspace-q3 --json"],
    run: (cfg, p) => cmdShare(cfg, p),
  },
  query: {
    group: "Graph", parse: "raw", args: "[--type T] [--where k=v] [--edges]",
    summary: "filterable node/edge enumeration",
    help:
      "Deterministic, filterable enumeration over the graph — the structured list\n" +
      "that `get` (one node), `next` (the ranked queue) and `compile --query`\n" +
      "(semantic search) are not. Pure, no LLM. Dual-mode: local mode reads the local\n" +
      "nodes dir; remote mode runs the SAME enumeration over the TEAM graph (it fetches\n" +
      "the server's nodes via GET /v1/export, then queries it locally). Point --nodes\n" +
      "at a local checkout to query one even under a server.\n" +
      "\n" +
      "Node selection (AND across distinct flags):\n" +
      "  --type <T>        nodes of that type: (repeatable -> OR within type)\n" +
      "  --where key=val   match a frontmatter field (repeatable -> AND); a list\n" +
      "                    field (e.g. tags) matches on membership\n" +
      "  --id-prefix <p>   ids starting with <p>\n" +
      "\n" +
      "Edge emission (switches output from nodes to {from,type,to} edges; the node\n" +
      "predicates above then restrict each emitted edge's SOURCE):\n" +
      "  --edges           emit edges instead of nodes\n" +
      "  --edge-type <T>   filter edges by type\n" +
      "  --from <id>       out-edges whose source is <id>\n" +
      "  --to <id>         in-edges whose target is <id>\n" +
      "\n" +
      "Projection: default table; --ids (one id per line), --summary (id + summary),\n" +
      "--full (raw node block), --json (machine output). --nodes <dir> overrides the\n" +
      "graph dir.",
    examples: [
      "spor query --type repo --ids",
      "spor query --where status=open --type task --json",
      "spor query --edges --edge-type grouped-under --to proj-rdi",
    ],
    run: (cfg, args) => cmdQuery(cfg, args),
  },
  analytics: {
    group: "Graph", parse: "raw", args: "[--project S] [--type T] [--weeks N] [--json]",
    summary: "created-vs-completed work metrics",
    help:
      "Surface work-flow analytics over the git-derived timestamp index: created vs.\n" +
      "completed work per ISO week, throughput, cycle time, current WIP by type, and\n" +
      "the oldest-open bottlenecks. Local mode folds the local graph's git history;\n" +
      "remote mode dispatches to the server's GET /v1/analytics (which owns the graph\n" +
      "and its history there). Point --nodes at a local checkout to read one under a\n" +
      "server.\n" +
      "\n" +
      "Completion time is a node's status-TRANSITION time (when it entered its final\n" +
      "terminal run), derived from git content history — never updated_at, which a\n" +
      "later edge append would push past completion (dec-spor-git-derived-timestamps).\n" +
      "Supersession (no status change of its own) falls back to the superseding node's\n" +
      "creation; a non-git home falls back to frontmatter dates.\n" +
      "\n" +
      "  --project <S>   scope to a repo slug / repo-<slug> / grouping id (like `next`)\n" +
      "  --type <T>      restrict to these node types (repeatable, comma-ok)\n" +
      "  --weeks <N>     weekly-cohort window length (default 12)\n" +
      "  --top <N>       bottleneck list length (default 10)\n" +
      "  --aging <N>     aging-WIP / bottleneck age threshold in days (default 30)\n" +
      "  --json          machine-readable report\n" +
      "  --nodes <dir>   read this local graph dir instead of the resolved home",
    examples: [
      "spor analytics",
      "spor analytics --project spor --type task,issue",
      "spor analytics --weeks 8 --json",
    ],
    run: (cfg, args) => cmdAnalytics(cfg, args),
  },
  schema: {
    group: "Graph", parse: "raw", args: "[<type>|candidates|adopt <id>] [--edges] [--json]",
    summary: "introspect the live schema registry (local; remote via the server)",
    help:
      "Introspect the LIVE schema registry — the contract (norm-cc-registry-is-\n" +
      "contract): every node and edge type with its id prefixes, edge weights, ride-\n" +
      "along flags (always_on / traversable / capturable / queueable), the status-\n" +
      "resolution partition, and the attached validate()/transitions()/get() gates.\n" +
      "Merges the seed pack with graph-resident `type: schema` overrides and tags each\n" +
      "entry's provenance (seed / graph / native). Query this instead of reading\n" +
      "lib/seed/ files directly — those miss graph-resident overrides.\n" +
      "\n" +
      "Local mode reads the local graph's registry; remote mode reflects the SERVER's\n" +
      "live registry (GET /v1/schema). Point --nodes at a local checkout to read one\n" +
      "under a server.\n" +
      "\n" +
      "  <type>            detail for one node/edge type (flags, provenance, and each\n" +
      "                    validate()/transitions()/get() hook's source)\n" +
      "  --edges           list edge types only\n" +
      "  --nodes-only      list node types only\n" +
      "  --source <s>      filter the lists by provenance (seed | graph | native)\n" +
      "  --code            include hook source in --json (implied for <type>)\n" +
      "  --json            machine-readable snapshot\n" +
      "  --nodes <dir>     read this local graph dir instead of the resolved home\n" +
      "\n" +
      "Candidate pack (rollout-stage schemas that ship with the package but stay\n" +
      "inert until a graph adopts them as graph-resident schema nodes):\n" +
      "  candidates        list packaged candidates with their adoption state\n" +
      "  adopt <id>        write a candidate into the active graph through the\n" +
      "                    validated node surface (status: proposed; --activate\n" +
      "                    writes active — the trusted-admin lever for solo/local\n" +
      "                    graphs). Re-run after a package upgrade: a pristine\n" +
      "                    older copy upgrades in place, a locally modified one\n" +
      "                    refuses without --force.",
    examples: [
      "spor schema",
      "spor schema task",
      "spor schema --edges --json",
      "spor schema --source graph",
      "spor schema candidates",
      "spor schema adopt schema-edge-member-of-program --activate",
    ],
    run: (cfg, args) => cmdSchema(cfg, args),
  },
  changes: {
    group: "Graph", parse: "raw", args: "[--since <sha|date>] [--project S] [--limit N] [--json]",
    summary: "recent graph activity feed (local: git log; remote: /v1/changes)",
    help:
      "Show the team's recent-activity feed — \"what landed / what did the agents\n" +
      "write overnight / what changed since <commit>\". The temporal entry point the\n" +
      "other reads lack (`next` is forward-looking open work, `compile` is semantic\n" +
      "search). Dual-mode: remote mode wraps GET /v1/changes (the server's git-log\n" +
      "projection over nodes/, the REST twin of the recent_changes MCP tool); local\n" +
      "mode runs the SAME projection over the local graph's git history and renders\n" +
      "identically (norm-spor-cli-mode-parity).\n" +
      "\n" +
      "One entry per node = its NEWEST change in range, newest-first, each tagged\n" +
      "machine (capture/distill/gardener) vs human — the trust signal the rendered\n" +
      "digest hides.\n" +
      "\n" +
      "  --since <sha|date>  changes in <sha>..HEAD (7-40 hex sha; unresolvable = error)\n" +
      "                      or a date/relative phrase git understands ('12 hours ago',\n" +
      "                      '2026-06-15'); omitted = the most recent changes\n" +
      "  --project <S>       scope to one project's nodes (deletions omitted when scoped)\n" +
      "  --limit <N>         max nodes returned (default 100, max 500)\n" +
      "  --json              machine-readable envelope\n" +
      "  --nodes <dir>       read this local graph dir instead of the resolved home",
    examples: [
      "spor changes",
      "spor changes --since '12 hours ago'",
      "spor changes --since a1b2c3d --project spor",
      "spor changes --limit 20 --json",
    ],
    run: (cfg, args) => cmdChanges(cfg, args),
  },
  program: {
    group: "Graph", parse: "raw", args: "<id> [--max-depth N] [--max-nodes N] [--json]",
    summary: "birds-eye program/progress view over blocks topology",
    help:
      "Show the program/progress view for a workstream: given a root node other\n" +
      "work `blocks` (an umbrella task, a milestone), the gating tree of everything\n" +
      "that blocks it — transitively over inbound `blocks` edges — with resolution-\n" +
      "derived progress. `next` answers \"what's next\"; `program` answers \"how far\n" +
      "along is the whole thing\". The shell front-door for the render_program MCP\n" +
      "tool / GET /v1/program/{id} (API.md §3).\n" +
      "\n" +
      "A node is `done` when a live resolves/answers edge, a terminal status, or\n" +
      "supersession retires it (even while the status field lags); `blocked` when a\n" +
      "live node has its own unresolved live blocker; otherwise `active` (status:\n" +
      "active) or `open`. Remote mode dispatches to GET /v1/program/{id} and prints\n" +
      "the server's own rendering straight through; local mode walks the local\n" +
      "graph's `blocks` edges itself. A shared blocker renders once per occurrence\n" +
      "but counts once in the totals; an unknown root is an error. A root nothing\n" +
      "blocks is a successful empty result — add `blocks` edges from the gating\n" +
      "tasks to model the program (see /spor:spor \"Grouping work under an umbrella\n" +
      "node\").\n" +
      "\n" +
      "  <id>              the root node id (an umbrella task, a milestone)\n" +
      "  --max-depth <N>   bound how many `blocks` hops out from the root are walked\n" +
      "  --max-nodes <N>   bound the total distinct nodes visited\n" +
      "  --json            machine-readable envelope\n" +
      "  --nodes <dir>     read this local graph dir instead of the resolved home",
    examples: [
      "spor program task-platform-hardening-program",
      "spor program task-platform-hardening-program --max-depth 3",
      "spor program task-platform-hardening-program --json",
    ],
    run: (cfg, args) => cmdProgram(cfg, args),
  },
  check: {
    group: "Graph", parse: "raw", args: "[--staged|--range <a..b>|--files <f...>] [--strict] [--json]",
    summary: "coupling-drift report over a diff — triggers touched, targets not",
    help:
      "Check a change set against the graph's COUPLING NORMS (norm nodes carrying\n" +
      "couples_when/couples_also file globs — GRAPH.md \"coupling anchors\"): report\n" +
      "each norm whose trigger set is touched while its target set is not — the\n" +
      "boundary-time twin of the edit-time post-tool coupling nudge, sharing one\n" +
      "matcher (lib/kernel/coupling.js). A norm carrying a value invariant\n" +
      "(couples_value_a/b: <path>#<regex>) has its two extracted values compared:\n" +
      "\"these now disagree\" beats \"you probably forgot\", and an agreeing invariant\n" +
      "suppresses the untouched heuristic. Targets pinned to another repo are\n" +
      "surfaced as reminders, never failures (verify them there).\n" +
      "\n" +
      "The change set is always LOCAL git; the norms are mode-aware (local graph, or\n" +
      "the team graph via GET /v1/export in remote mode).\n" +
      "\n" +
      "  --staged          check the index only (the pre-commit view); default is\n" +
      "                    everything uncommitted vs HEAD plus untracked files\n" +
      "  --range <a..b>    check a commit range (CI; value invariants read the right side)\n" +
      "  --files <f...>    an explicit file list (paths, repo-relative or absolute)\n" +
      "  --strict          exit 1 when findings exist (CI / pre-commit enforcement)\n" +
      "  --json            machine-readable {project, changed, checked, findings}\n" +
      "  --nodes <dir>     read this local graph dir instead of the resolved home",
    examples: [
      "spor check",
      "spor check --staged --strict",
      "spor check --range origin/main..HEAD --strict",
      "spor check --files lib/seed/schema-task.md --json",
    ],
    run: (cfg, args) => cmdCheck(cfg, args),
  },
  export: {
    group: "Graph", parse: "strict", args: "[--gzip] [--history|--auth] [--out <file>]",
    summary: "the nodes/ tarball, or the --history bundle / --auth restore backup (GET /v1/export)",
    help:
      "Stream the graph's nodes/ as a POSIX ustar tarball — the shell front-door for\n" +
      "GET /v1/export, for seeding a local read replica or bootstrapping a fresh graph\n" +
      "from a snapshot. Replaces hand-rolling `curl … | tar x`.\n" +
      "\n" +
      "Dual-mode (norm-spor-cli-mode-parity): remote downloads GET /v1/export (the\n" +
      "server compresses when --gzip); local builds the same ustar format from the\n" +
      "graph home's nodes/ and gzips via the zlib builtin. `tar x` reproduces nodes/\n" +
      "byte-for-byte in either mode.\n" +
      "\n" +
      "Two more export modes are REMOTE-ONLY (no local twin) and mutually exclusive:\n" +
      "  --history  a `git bundle --all` of the graph repo with full commit provenance —\n" +
      "             the customer data-exit path. `git clone <bundle> graph` reproduces\n" +
      "             the whole history. (--gzip is a no-op here; a bundle is already packed.)\n" +
      "  --auth     admin-gated (stewards-root) backup that ALSO bundles auth/*.json so a\n" +
      "             disaster restore reproduces the credential set, not just nodes/. A\n" +
      "             non-admin caller gets a 403 from the server.\n" +
      "\n" +
      "The output is written to --out, or to stdout when omitted so it pipes straight\n" +
      "into tar (`spor export --gzip | tar xz`); the node/auth count, size and graph\n" +
      "head ride stderr so they never pollute a piped tarball.\n" +
      "\n" +
      "  --gzip          gzip-compress the tarball (server-side remote, zlib local)\n" +
      "  --history       git bundle of the whole repo (remote-only; full provenance)\n" +
      "  --auth          include auth/*.json for restore (remote-only; admin-gated)\n" +
      "  --out <file>    write to <file> instead of stdout",
    options: {
      gzip: { type: "boolean", desc: "gzip-compress the tarball" },
      history: { type: "boolean", desc: "git bundle of the whole repo (remote-only)" },
      auth: { type: "boolean", desc: "include auth/*.json for restore (remote-only, admin-gated)" },
      out: { type: "string", value: "file", desc: "write to <file> instead of stdout" },
    },
    examples: [
      "spor export --out graph-nodes.tar",
      "spor export --gzip --out graph-nodes.tar.gz",
      "spor export --gzip | tar xz",
      "spor export --history --out graph-history.bundle",
      "spor export --auth --gzip --out graph-restore.tar.gz",
    ],
    run: (cfg, p) => cmdExport(cfg, p),
  },
  merge: {
    group: "Team admin (remote, admin token)", parse: "strict",
    args: "<nodes-dir|tarball> [--apply] [--force] [--trust-attached-code] [--id-map <file>] [--save-id-map <file>] [--json]",
    summary: "bring another graph's exported nodes into this one (POST /v1/merge)",
    help:
      "Bring another graph's exported nodes into the team graph — pilot-to-org\n" +
      "promotion, or a local dogfood graph into a hosted tenant — replacing the\n" +
      "hand-rolled curl+jq the runbook used until now. Remote + admin only\n" +
      "(stewards→root): the endpoint merges INTO the server's graph, so there is\n" +
      "no local-mode equivalent.\n" +
      "\n" +
      "<nodes-dir|tarball> is either a directory of node markdown files (a nodes/\n" +
      "dir itself, or its parent — the shape `spor export`/`tar x` produces), or a\n" +
      "tarball file (gzipped or plain, the same format `spor export [--gzip]`\n" +
      "writes) — so the natural flow is `spor export --gzip --out pilot.tar.gz` on\n" +
      "the pilot graph, then `spor merge pilot.tar.gz` against the org server.\n" +
      "\n" +
      "Defaults to plan mode: every incoming node classifies as imported / deduped\n" +
      "(attribution-blind, identical content) / remapped (an ordinal id collision,\n" +
      "rewritten to <id>-<hash> with references fixed up) / conflict (different\n" +
      "content, a semantic id, or a schema/workflow/stewards edge — never merged\n" +
      "silently) and NOTHING is written. Pass --apply to write; apply refuses with\n" +
      "409 if the plan still carries conflicts or errors, unless --force (imports\n" +
      "the clean subset, leaving references to skipped ids unresolved).\n" +
      "\n" +
      "  --apply                 write the merge (default: plan mode only, reports\n" +
      "                          impact and writes nothing)\n" +
      "  --force                 apply the clean subset even if conflicts/errors remain\n" +
      "  --trust-attached-code   let schema/workflow nodes merge verbatim (only for a\n" +
      "                          whole graph you own — it activates their gate code)\n" +
      "  --id-map <file>         seed cross-id rewrites from a prior plan's id_map (JSON),\n" +
      "                          for merging a graph too large for one batch\n" +
      "  --save-id-map <file>    write this response's id_map to <file>, to feed the\n" +
      "                          next batch\n" +
      "  --json                  print the raw merge report",
    options: {
      apply: { type: "boolean", desc: "write the merge (default: plan mode, reports impact only)" },
      force: { type: "boolean", desc: "apply the clean subset even if conflicts/errors remain" },
      "trust-attached-code": { type: "boolean", desc: "allow schema/workflow nodes to merge verbatim (only for a graph you own)" },
      "id-map": { type: "string", value: "file", desc: "seed cross-id rewrites from a prior plan's id_map (JSON file)" },
      "save-id-map": { type: "string", value: "file", desc: "write the response's id_map to <file>, to feed the next batch" },
      json: { type: "boolean", desc: "print the raw merge report" },
    },
    examples: [
      "spor merge ./pilot-export",
      "spor merge pilot.tar.gz",
      "spor merge pilot.tar.gz --apply",
      "spor merge pilot.tar.gz --id-map batch1.json --save-id-map batch2.json --apply",
    ],
    run: (cfg, p) => cmdMerge(cfg, p),
  },
  correct: {
    group: "Graph", parse: "strict", args: "<target> [guidance]", aliases: ["propose-correction"],
    summary: "record a standing briefing correction (local: corr file; remote: /v1/corrections)",
    help:
      "Record a correction that fires at every future compile whose scope includes the\n" +
      "target. The target is a node id (fixes one topic's briefing), project:<slug>\n" +
      "(every compile for that project), or global (every compile, every project).\n\n" +
      "Pin a node that was missed (--pin), exclude a stale/irrelevant one (--exclude),\n" +
      "and/or pass free-text guidance (positional or --guidance). --pin/--exclude are\n" +
      "repeatable and must name existing nodes. Remote mode POSTs /v1/corrections (the\n" +
      "server mints the corr-<target>-<n> id); local mode writes the corr node file.",
    options: {
      pin: { type: "string", value: "id", desc: "pin a node that was missed (repeatable)", multiple: true },
      exclude: { type: "string", value: "id", desc: "exclude a stale/irrelevant node (repeatable)", multiple: true },
      guidance: { type: "string", value: "...", desc: "free-text guidance (else the second positional)" },
      title: { type: "string", value: "...", desc: "one-line title (default: 'correction for <target>')" },
    },
    examples: [
      'spor correct dec-x "lead with the rollback plan, it is the binding constraint"',
      "spor correct issue-86 --pin dec-new-policy --exclude dec-stale",
      'spor correct project:spor "always cite the conformance suite for refactors"',
    ],
    run: (cfg, p) => cmdCorrect(cfg, p),
  },
  priority: {
    group: "Graph", parse: "strict", args: "<id> <p1|p2|p3|clear>", aliases: ["set-priority"],
    summary: "set a queue item's human-triage priority (local: in-place; remote: /v1/nodes/{id}/priority)",
    help:
      "Set (or clear) a node's human-triage priority — the override half of the queue\n" +
      "blend, where p1/p2/p3 bumps an item above the signal-ranked front. The value is\n" +
      "p1 (highest), p2, p3, or none/clear to remove it (p0 and an empty value clear\n" +
      "too). The change is stamped with your identity and the door it came through\n" +
      "(priority_by/_at/_via) so an agent-set priority is distinguishable from human\n" +
      "triage. Remote mode POSTs /v1/nodes/{id}/priority (the set_priority micro-\n" +
      "mutation — one call, no revision round-trip); local mode rewrites the node\n" +
      "file's frontmatter in place, attributing to your git identity.",
    options: {},
    examples: ["spor priority issue-86 p1", "spor priority task-x p3", "spor priority issue-86 clear"],
    run: (cfg, p) => cmdPriority(cfg, p),
  },
  ready: {
    group: "Graph", parse: "strict", args: "<id> [--needs-input]",
    summary: "stamp a queue item agent-ready, or demote it back to derived (local: in-place; remote: /v1/nodes/{id}/readiness)",
    help:
      "Stamp (or clear) a node's agent-readiness override — the ONE hand-set piece\n" +
      "of the otherwise-derived classification (dec-spor-agent-readiness-derived-\n" +
      "classification): rankQueue/show_queue compute `readiness: agent|human|\n" +
      "untriaged` structurally, and `readiness: agent` (with readiness_by\n" +
      "provenance) is the only value a human or agent hand-sets.\n\n" +
      "`spor ready <id>` stamps `readiness: agent` — the item then classifies agent\n" +
      "and rides suggest:dispatch. `--needs-input` clears the stamp instead: a manual\n" +
      "demotion back OFF agent-ready to whatever the structural derivation produces\n" +
      "(human, if a requires:human/assigned-person/held/open-question signal already\n" +
      "applies; untriaged otherwise). There is no hand-settable `readiness: human`\n" +
      "value — human is always derived structurally, and a make-ready pass records a\n" +
      "hard gap as an explicit `blocks` edge instead.\n\n" +
      "The stamp is an OVERRIDE, not a status: a later open question or requires:human\n" +
      "edit still wins and flips a stamped item back to human (deriveReadiness checks\n" +
      "the human conditions before the readiness:agent stamp). The change is stamped\n" +
      "with your identity and the door it came through (readiness_by/_at/_via),\n" +
      "mirroring priority/priority_by. Remote mode POSTs /v1/nodes/{id}/readiness (one\n" +
      "call, no revision round-trip); local mode rewrites the node file's frontmatter\n" +
      "in place, attributing to your git identity.",
    options: {
      "needs-input": { type: "boolean", desc: "demote: clear the agent-ready stamp (falls back to derived classification)" },
    },
    examples: ["spor ready task-x", "spor ready task-x --needs-input"],
    run: (cfg, p) => cmdReady(cfg, p),
  },
  "set-status": {
    group: "Graph", parse: "strict", args: "<id> <status>", aliases: ["status-set"],
    summary: "set a node's status, claiming it on an active status (local: in-place; remote: /v1/nodes/{id}/status)",
    help:
      "Set a node's status — the precise-write counterpart to the prose-only 'spor\n" +
      "add'. Setting a work node to an ACTIVE status (active/open/in-progress, or any\n" +
      "status a schema maps to the active category) also CLAIMS it: the server takes\n" +
      "the heartbeat lease that keeps the item out of teammates' actionable queues\n" +
      "(dec-cc-task-claim-lease), and the response reports whether you hold it. A\n" +
      "terminal status (done/abandoned/resolved/…) leaves any claim untouched —\n" +
      "release is its own op. Remote mode POSTs /v1/nodes/{id}/status (the set_status\n" +
      "micro-mutation; the server runs the type's status enum + transitions() gate, so\n" +
      "e.g. 'done' on a task still needs a resolving decision/artifact); local mode\n" +
      "rewrites the node file's status in place (no lease — local has no claim pool).",
    options: {},
    examples: ["spor set-status task-x active", "spor set-status question-7 answered", "spor set-status issue-9 resolved"],
    run: (cfg, p) => cmdSetStatus(cfg, p),
  },
  edge: {
    group: "Graph", parse: "strict", args: "<id> <type> <to>", aliases: ["add-edge"],
    summary: "add a typed edge from a node (local: in-place; remote: /v1/nodes/{id}/edges)",
    help:
      "Add a typed edge from <id> to <to> — close a loop with 'resolves', mark a\n" +
      "dependency with 'blocks'/'blocked-by', or relate two nodes — without a raw\n" +
      "curl or a whole-node rewrite. The edge type must be known to the registry\n" +
      "(canonical, a rename alias, or an inverse form, which stores the canonical\n" +
      "edge on the OTHER node); both ids must already exist (add_edge never creates\n" +
      "a dangling edge — create the target first). Re-adding an existing edge is an\n" +
      "idempotent no-op. --attr key=value (repeatable) carries flat edge attributes\n" +
      "(e.g. a per-assignment 'profile:' override). Remote mode POSTs\n" +
      "/v1/nodes/{id}/edges (the add_edge micro-mutation); local mode appends the\n" +
      "edge line to the node file, normalizing and validating it the same way.",
    options: {
      attr: { type: "string", value: "key=value", desc: "flat edge attribute (repeatable)", multiple: true },
    },
    examples: [
      "spor edge dec-x resolves task-y",
      "spor edge task-a blocked-by task-b",
      "spor edge task-x assigned agent-z --attr profile=profile-fast",
    ],
    run: (cfg, p) => cmdEdge(cfg, p),
  },
  claim: {
    group: "Graph", parse: "strict", args: "<node-id>",
    summary: "take the heartbeat-renewed lease on a task (remote: /v1/nodes/{id}/claim)",
    help:
      "Manually claim a task — take the heartbeat-renewed lease that marks it\n" +
      "yours-in-progress and keeps it out of teammates' actionable queues\n" +
      "(dec-cc-task-claim-lease). Writes the durable 'assigned' edge once and creates\n" +
      "the ephemeral server lease (default TTL 45m), attributed to you from your\n" +
      "token — never an argument. Re-claiming your OWN live claim just renews it; a\n" +
      "live lease held by someone ELSE is refused naming the holder + expiry. Keep it\n" +
      "alive with 'spor renew', stretch it with 'spor extend', hand it back with\n" +
      "'spor release'. Remote-only — local mode has no claim pool, so it no-ops with\n" +
      "a note.",
    options: {},
    examples: ["spor claim task-x"],
    run: (cfg, p) => cmdLease(cfg, "claim", p),
  },
  renew: {
    group: "Graph", parse: "strict", args: "<node-id>",
    summary: "heartbeat your live claim, bumping its expiry (remote: /v1/nodes/{id}/renew)",
    help:
      "Renew (heartbeat) your live claim on a task — bump the lease expiry so it\n" +
      "doesn't lapse during a long stretch of work. No commit; the durable 'assigned'\n" +
      "edge is untouched. While you work in Claude Code the post-tool hook renews\n" +
      "automatically on write-activity (task-cc-claim-nudge-hook); this is the manual\n" +
      "equivalent for a plain shell session. A lapsed or stolen lease is refused\n" +
      "naming the current holder (renew never re-creates a lapsed lease — that's a\n" +
      "fresh 'spor claim'). Remote-only — local mode has no lease.",
    options: {},
    examples: ["spor renew task-x"],
    run: (cfg, p) => cmdLease(cfg, "renew", p),
  },
  extend: {
    group: "Graph", parse: "strict", args: "<node-id> <duration>",
    summary: "extend your live claim by a duration, up to the org max (remote: /v1/nodes/{id}/extend)",
    help:
      "Extend your live claim on a task by a given duration — for a known long idle\n" +
      "gap (a meeting, overnight) where the default 45m heartbeat window would lapse.\n" +
      "The duration is 2h / 45m / 30s / 1d (or a bare integer of milliseconds). The\n" +
      "new expiry is bounded by the tenant's claim_ttl_max policy: it never shortens a\n" +
      "lease, and a request past the ceiling is capped to it (reported on the result).\n" +
      "A lapsed or stolen lease is refused naming the holder. Remote-only — local mode\n" +
      "has no lease.",
    options: {},
    examples: ["spor extend task-x 2h", "spor extend task-x 90m"],
    run: (cfg, p) => cmdLease(cfg, "extend", p),
  },
  release: {
    group: "Graph", parse: "strict", args: "<node-id>",
    summary: "hand a task back to the pool, retiring the assigned edge (remote: /v1/nodes/{id}/release)",
    help:
      "Release your claim on a task — drop the lease AND retire the durable 'assigned'\n" +
      "edge, returning the task to the pool so a teammate can pick it up. Idempotent:\n" +
      "releasing a task you hold no lease on still cleans up any lingering 'assigned'\n" +
      "edge of yours and succeeds. Releasing a claim SOMEONE ELSE holds is refused\n" +
      "naming the holder — you can't release another's claim. Remote-only — local mode\n" +
      "has no lease.",
    options: {},
    examples: ["spor release task-x"],
    run: (cfg, p) => cmdLease(cfg, "release", p),
  },

  // --- Repo scoping ---
  disable: {
    group: "Repo scoping", parse: "strict", args: "", options: {},
    summary: "turn Spor off for this repo (.spor.json)",
    help: "Set { enabled: false } in this repo's committable .spor.json. The hooks then\nno-op here until re-enabled. Commit the file to share the setting.",
    run: (cfg) => cmdScope(false),
  },
  enable: {
    group: "Repo scoping", parse: "strict", args: "",
    options: { "no-agents": { type: "boolean", desc: "skip writing the AGENTS.md capture-discipline directive" } },
    summary: "opt this repo in (.spor.json + AGENTS.md directive)",
    help: "Set { enabled: true } in this repo's committable .spor.json. Spor is opt-in\nper repo — a repo with no .spor/.spor.json marker is a no-op — so this is how\nyou turn it on (and how you undo a prior 'spor disable'). Also writes the\nAGENTS.md capture-discipline directive (see 'spor help agents-md'; skip with\n--no-agents). Commit the files to share the setting.",
    run: async (cfg, p) => {
      const rc = cmdScope(true);
      // Enabling is the moment this repo's work was decided to belong in the
      // graph — the standing directive rides along by default.
      if (rc === 0 && !p.values["no-agents"]) await cmdAgentsMd(cfg, { values: {} });
      return rc;
    },
  },
  "agents-md": {
    group: "Repo scoping", parse: "strict", args: "", aliases: ["agents"],
    summary: "write/refresh the committed AGENTS.md graph-upkeep directive",
    help:
      "Write (or idempotently refresh) the managed Spor block in AGENTS.md at the\n" +
      "repo root: standing user-voice instructions to keep the graph current —\n" +
      "capture discovered work when it appears, file issues before fixing, prefer\n" +
      "the graph over private auto-memory for durable facts, resolve with\n" +
      "artifacts, add Spor: commit trailers. Committed, it reaches every\n" +
      "contributor and dispatched agent; 'spor upgrade' refreshes the wording.\n" +
      "If a CLAUDE.md exists that never mentions AGENTS.md, an @AGENTS.md import\n" +
      "is appended so Claude Code sessions inherit the directive too.\n" +
      "By default the block carries the directive only (hooked hosts get their\n" +
      "briefing at session start); --briefing also embeds the standing project\n" +
      "briefing — the floor for hosts without hooks (same block 'spor-hook\n" +
      "agents-md' maintains from adapter session-start hooks). The tools-line\n" +
      "sentence pointing at your SPOR_SERVER's MCP endpoint is omitted\n" +
      "automatically when that server is loopback (127.0.0.0/8 in any form,\n" +
      "localhost, ::1, or an IPv4-mapped/-compatible equivalent)\n" +
      "— a machine-local address has no business in a committed file;\n" +
      "--no-server-line omits it unconditionally, even for a public URL.",
    options: {
      briefing: { type: "boolean", desc: "also embed the standing project briefing (hook-less floor)" },
      "no-claude-md": { type: "boolean", desc: "don't append the @AGENTS.md import to an existing CLAUDE.md" },
      "no-server-line": {
        type: "boolean",
        desc: "omit the 'reachable over MCP at ...' sentence unconditionally (a loopback SPOR_SERVER is already omitted by default)",
      },
    },
    examples: ["spor agents-md", "spor agents-md --briefing", "spor agents-md --no-server-line"],
    run: (cfg, p) => cmdAgentsMd(cfg, p),
  },
  link: {
    group: "Repo scoping", parse: "strict", args: "<slug>", options: {},
    summary: "set this repo's canonical project slug (.spor marker)",
    help: "Write a .spor identity marker (repo: <slug>) at the repo root, fixing a wrong\ninferred slug deterministically. The slug must be canonical (^[a-z0-9][a-z0-9-]*$).\nWith no slug it uses the inferred one. Commit the marker to share the identity.",
    examples: ["spor link my-repo"],
    run: (cfg, p) => cmdLink(cfg, p),
  },
  compile: {
    group: "Repo scoping", parse: "raw", args: "<args>",
    summary: "full neighborhood / digest (local byte-identical; remote via the server)",
    help:
      "Compile a node neighborhood or a prompt-time digest. In local mode this is a\n" +
      "byte-identical passthrough to lib/compile.js (norm-cc-byte-identical-refactor).\n" +
      "In remote mode it dispatches to the server (--root/--query mirror the\n" +
      "/spor:brief skill: GET /v1/nodes then POST /v1/digest); --skeleton is local-\n" +
      "only. An explicit --nodes always names a local checkout, even under a server.",
    options: {
      root: { type: "string", value: "id", desc: "compile a node's neighborhood" },
      query: { type: "string", value: "text", desc: "compile from free-text (query mode)" },
      project: { type: "string", value: "slug", desc: "session slug (scopes project: corrections)" },
      nodes: { type: "string", value: "dir", desc: "graph nodes dir (default: $SPOR_HOME/nodes)" },
      digest: { type: "boolean", desc: "emit a compact prompt-time digest" },
      skeleton: { type: "boolean", desc: "write a versioned briefing-node skeleton (root mode)" },
      "min-sim": { type: "string", value: "n", desc: "query-mode relevance gate (default: 0.08)" },
      out: { type: "string", value: "file", desc: "write to a file instead of stdout" },
      quiet: { type: "boolean", desc: "suppress the stderr stats / no-graph lines" },
    },
    examples: ['spor compile --root dec-x', 'spor compile --query "auth token rotation" --digest'],
    run: (cfg, args) => cmdCompile(cfg, "compile", args),
  },
  brief: {
    group: "Repo scoping", parse: "raw", args: "<id>",
    summary: "compile a briefing for a node (sugar for compile --root <id>)",
    help: "Compile a briefing for one node — sugar for 'compile --root <id>'. Local mode\nis a byte-identical passthrough to lib/compile.js; remote mode dispatches to the\nserver (the raw node plus a /v1/digest neighborhood), like the /spor:brief skill.",
    examples: ["spor brief dec-cc-zero-dep-client"],
    run: (cfg, args) => cmdCompile(cfg, "brief", args),
  },
  validate: {
    group: "Repo scoping", parse: "raw", args: "",
    summary: "lint the local graph (byte-identical)",
    help: "Lint the local graph and exit 1 on errors. Byte-identical passthrough to\nlib/validate.js. Local-only — in remote mode the server validates every write,\nso this fails fast unless --nodes points at a local checkout.",
    options: { nodes: { type: "string", value: "dir", desc: "graph nodes dir to lint" } },
    run: (cfg, args) => cmdValidate(cfg, args),
  },

  // --- Dispatch ---
  dispatch: {
    group: "Dispatch (background agents)", parse: "strict", args: '"<task>" | <node-id>', aliases: ["bg"],
    summary: "compile a briefing + launch the profile-selected harness",
    help:
      "Compile a briefing for a task and launch a background agent in the right repo.\n" +
      "A resolved profile selects its harness (claude-code or codex); with no profile,\n" +
      "dispatch preserves the legacy Claude Code path. Give free-text, a <node-id>,\n" +
      "--node <id>, --from-queue (the top\n" +
      "ranked item NOT already in flight on this machine), or --backfill (the\n" +
      "unattended init + enable + launch-/spor:backfill primitive; first-time setup\n" +
      "goes through the /spor:onboard skill instead). The target dir is the\n" +
      "slug->path map ('spor repos'), overridable with --dir.\n\n" +
      "In remote mode a node dispatch auto-claims the task — it establishes the\n" +
      "heartbeat lease at dispatch time, so concurrent dispatch of the same node is\n" +
      "refused (the holder is named). --no-claim opts out (dispatch with no lease).\n\n" +
      "A node dispatch is also refused if an agent for that node is already in flight\n" +
      "on THIS machine (each agent is named after its node id) — catches the\n" +
      "same-person duplicate the lease's idempotent renew can't. --force overrides.\n\n" +
      "And it is refused if the target is already resolved — a terminal status, or\n" +
      "retired by an inbound resolves/answers edge — so an agent is never sent to redo\n" +
      "finished work. --force overrides.\n\n" +
      "A node dispatch also checks its derived agent-readiness (dec-spor-agent-\n" +
      "readiness-derived-classification): 'requires: human' work REFUSES outright,\n" +
      "naming the gap — no --force override, since no agent can do it regardless of\n" +
      "capability. A broader human classification (assigned to a person, a held\n" +
      "task, an open neighborhood question) only WARNS; the dispatch proceeds.\n\n" +
      "--worktree runs the agent in its own git worktree off the repo (branch = the\n" +
      "node id / sanitized task), so parallel dispatches never race the shared tree/\n" +
      "index. Make it a repo default with dispatch.worktree — in the TARGET repo's\n" +
      "committable .spor.json (honored wherever it's dispatched from) or your\n" +
      "machine-local config. dispatch.worktreeSetup names a hook (script path or\n" +
      "command; relative paths resolve against the repo) that preps each worktree —\n" +
      "it runs with cwd=worktree and SPOR_WORKTREE/SPOR_MAIN_CHECKOUT/\n" +
      "SPOR_DISPATCH_SLUG|NODE in the env (e.g. symlink node_modules, write\n" +
      ".claude/settings.local.json env). --no-worktree opts a single run out.\n\n" +
      "--template supplies your own prompt with {{brief}}/{{task}}/{{node}}/{{id}}/{{title}}/\n" +
      "{{summary}}/{{type}}/{{status}}/{{date}}/{{slug}}/{{dir}}/{{default}} placeholders\n" +
      "(the node fields are populated from the dispatched node's frontmatter, blank in\n" +
      "free-text/--backfill dispatch).\n\n" +
      "A template written for one isolation mode can mismatch the other: a prompt that\n" +
      "promises an isolated worktree (branch-per-agent, someone else merges) misleads an\n" +
      "agent run with --no-worktree straight into the shared checkout, and vice versa.\n" +
      "Write or pick a template that matches the flag you pass — this repo's own\n" +
      "spor-orchestrator skill ships both a worktree variant (assets/agent-prompt.md) and\n" +
      "a --no-worktree variant (assets/agent-prompt-inplace.md, asserting shared-checkout\n" +
      "discipline instead of isolation) as a template pair to model this split on.\n\n" +
      "Two different 'agent' axes, don't confuse them: --as picks the Spor agent\n" +
      "IDENTITY the dispatch runs AS (attribution 'agent on behalf of person',\n" +
      "remote-only; defaults to dispatch.agent — set it with 'spor agent use <id>').\n" +
      "--agent is the unrelated 'claude --agent' passthrough that picks the harness\n" +
      "agent DEFINITION (subagent personality/toolset) the background session runs.",
    options: {
      dir: { type: "string", value: "path", desc: "launch directory (overrides the slug map)" },
      node: { type: "string", value: "id", desc: "dispatch a specific node id" },
      slug: { type: "string", value: "slug", desc: "target project slug (cross-repo resolution)" },
      as: { type: "string", value: "agent-id", desc: "Spor agent IDENTITY to run as (overrides dispatch.agent; remote-only)" },
      model: { type: "string", value: "M", desc: "harness model override (otherwise profile.model)" },
      "permission-mode": { type: "string", value: "P", desc: "claude --permission-mode" },
      sandbox: { type: "string", value: "S", desc: "codex exec --sandbox (default: workspace-write)" },
      "approval-policy": { type: "string", value: "P", desc: "codex exec --ask-for-approval (default: never)" },
      "read-only": { type: "boolean", desc: "run under the harness's read-only posture (codex --sandbox read-only, claude --permission-mode plan); overrides --sandbox/--permission-mode" },
      agent: { type: "string", value: "A", desc: "claude --agent (harness agent DEFINITION — NOT the Spor identity; see --as)" },
      profile: { type: "string", value: "profile-id", desc: "profile to run under; checked against this machine's capabilities (overrides the assigned/default profile)" },
      name: { type: "string", value: "N", desc: "dispatch run name (passed to Claude; tracked locally for Codex)" },
      template: { type: "string", value: "F", desc: "prompt template file (placeholders above)" },
      full: { type: "boolean", desc: "full briefing instead of the digest" },
      "no-brief": { type: "boolean", desc: "raw task prompt, no briefing block" },
      "no-claim": { type: "boolean", desc: "don't auto-claim the lease (remote node dispatch)" },
      "allow-person-token": { type: "boolean", desc: "fall back to a person-scoped token when no agent is configured or minting fails (default: hard-fail; also dispatch.allowPersonToken)" },
      force: { type: "boolean", desc: "dispatch even if the node is already resolved, or an agent for it is in flight here" },
      "from-queue": { type: "boolean", desc: "dispatch the top-ranked queue item not already in flight here" },
      backfill: { type: "boolean", desc: "init + enable + launch /spor:backfill (the primitive behind /spor:onboard)" },
      worktree: { type: "boolean", desc: "run the agent in its own git worktree (overrides dispatch.worktree)" },
      "no-worktree": { type: "boolean", desc: "force-disable worktree isolation for this dispatch" },
      bg: { type: "boolean", desc: "Claude Code only: launch native-background (claude --bg, attachable with 'claude attach') instead of the supervised headless run — unenforced outcome, no report channel; also dispatch.claudeLaunchMode" },
      print: { type: "boolean", desc: "dry run — print the prompt, launch nothing" },
      "dry-run": DRYRUN_OPT,
    },
    examples: ['spor dispatch "rotate the pipeline auth tokens" --dir ../api', "spor dispatch dec-x --model haiku", "spor dispatch --from-queue --print"],
    run: (cfg, p) => cmdDispatch(cfg, p),
  },
  work: {
    group: "Dispatch (background agents)", parse: "strict", args: "", aliases: ["worker"],
    summary: "work the queue continuously — claim, dispatch, await, repeat",
    help:
      "The pull-based worker loop over the queue (task-spor-work-loop): poll the\n" +
      "ranked queue, take the items this machine may actually run, dispatch each one\n" +
      "under its routed profile, wait for its TERMINAL state, and go round again —\n" +
      "bounded by a concurrency cap and an exponential backoff when the queue has\n" +
      "nothing for this box. One command in place of a human orchestrating harnesses\n" +
      "by hand.\n\n" +
      "PULL, NOT PUSH. Nothing schedules this: the worker takes work. That is safe\n" +
      "because the claim is a server-held lease with a per-launch nonce, so two\n" +
      "workers racing for one node end with one claim and one refusal, and a worker\n" +
      "that dies drops its lease by lapsing. Capabilities stay machine-local facts\n" +
      "and the fleet scheduler stays advisory, so an offline worker degrades to\n" +
      "'work the queue with what I have' instead of stopping.\n\n" +
      "WHAT IT ACCEPTS. --accept (work.accept / SPOR_WORK_ACCEPT) sets the\n" +
      "acceptance policy: 'ready' — the DEFAULT — dispatches only items a person\n" +
      "explicitly stamped agent-ready ('spor ready <id>', or an assigned->agent\n" +
      "routing), so on a team nothing lands on a worker box without that green\n" +
      "light; untriaged items are skipped with a visible reason ('spor work\n" +
      "--status'). 'open' opts back into the looser pickup: everything except\n" +
      "readiness:human. That human floor is not part of the knob — no policy makes\n" +
      "a worker claim a human-readiness item (WORKERS.md §3). An unknown value\n" +
      "refuses to start the worker.\n\n" +
      "IT ADDS NO GUARDS. Every launch goes through 'spor dispatch --node <id>', so\n" +
      "already-resolved, requires:human, profile-unsatisfiable-here (never\n" +
      "substituted), graph-declared launch fields, the same-machine duplicate guard,\n" +
      "the auto-claim and its nonce, worktree isolation and the terminal-state\n" +
      "contract all apply exactly as they do one-shot. Selection is the same\n" +
      "filtered page --from-queue picks from, minus items whose derived readiness is\n" +
      "human (a worker never claims those) and minus anything already in flight here.\n" +
      "A refused item is remembered with the refusal's own reason and retried after\n" +
      "--retry-after, so the loop moves down the queue instead of re-refusing one item.\n\n" +
      "TERMINAL, NOT LAUNCHED. A slot frees when the RUN RECORD goes terminal AND its\n" +
      "outcome is settled — by then the terminal-state contract has filed the report\n" +
      "and released or held the lease — never when a launcher returns. Stopping\n" +
      "(SIGINT/SIGTERM, or --once/--max) stops PICKING UP work; runs already in flight\n" +
      "are detached, keep going, and self-report ('spor runs'). There is no --no-claim:\n" +
      "the lease is what keeps two workers off one node, so a loop always takes it.\n\n" +
      "A native-background harness (claude --bg) is the weak spot: its termination is\n" +
      "not deterministically observable (dec-spor-dispatch-terminal-states-supervised-\n" +
      "first), so a slot is freed from the harness's own live-agent listing, and if\n" +
      "that listing cannot be read the slot stays held and the worker says so. --run-max\n" +
      "(default 24h) is the backstop that stops following such a run. A supervised\n" +
      "harness (Codex, OpenCode, Copilot, a declared one) has none of this.\n\n" +
      "RUN IT AS A SERVICE. 'spor work --status' (add --json) reads back every\n" +
      "worker on this box: state, slots, dispatch count, verified outcomes, what it\n" +
      "is deliberately skipping and why. Records live under the machine-local\n" +
      "journal; a worker whose process is gone reads as stale, never as running.\n" +
      "Tune with the work.* config keys (accept, concurrency, intervalMs,\n" +
      "maxIntervalMs, retryAfterMs, project) so the unit file can be a bare\n" +
      "'spor work'.\n\n" +
      "GATES (task-spor-work-gate-pipeline). With no factory declared the loop runs\n" +
      "BARE — dispatch-only, exactly as it shipped. Point --factory (or work.factory)\n" +
      "at a 'type: factory' node and its ordered gate list is ENFORCED in code between\n" +
      "the claim and the resolve: a run that came back 'resolved' holds its slot while\n" +
      "the pipeline runs, and a gate that refuses cools the item off instead of\n" +
      "counting it done. Three gate kinds, inline in the factory node or referenced as\n" +
      "shareable 'type: gate' nodes (the runner treats them identically):\n\n" +
      "  command       runs the declared suite from the TRUSTED ref, never the\n" +
      "                implementer branch's copy of the tests; a branch that touched a\n" +
      "                declared protected test path fails CLOSED, unrun, and the test\n" +
      "                change is routed to a separate lane under another profile\n" +
      "  agent-review  dispatches a profile-routed (cross-model) review, parses its\n" +
      "                structured findings verdict IN CODE — an unreadable verdict is\n" +
      "                never a pass — loops implementer fix cycles up to the declared\n" +
      "                cap, then escalates by filing a human queue item\n" +
      "  human         keyed on declared risk classes; files an approval item and\n" +
      "                BLOCKS the resolve until a person answers it\n\n" +
      "Every gate outcome is written as a graph fact linked to the work item. A\n" +
      "factory that cannot be read, or does not validate, REFUSES to start the worker\n" +
      "rather than running it ungated.\n\n" +
      "A factory judges only the repos it declares ('repos' in its payload, defaulting\n" +
      "to the factory node's own repo stamp) — NOT whatever --project unions in: a bare\n" +
      "repo slug resolves up to its home-project grouping, so an undeclared factory\n" +
      "would gate sibling repos' items with a suite written for another checkout. An\n" +
      "out-of-scope item is skipped with the reason on stdout and in --status. With one\n" +
      "declared repo and no --project, that repo is also the default queue scope. See\n" +
      "WORKERS.md §10.",
    options: {
      project: { type: "string", value: "S", desc: "scope to a project slug (default: work.project/queue.project, else a single-repo factory's own repo, else the whole queue)" },
      accept: { type: "string", value: "P", desc: "acceptance policy: 'ready' dispatches only items explicitly stamped agent-ready (default; also work.accept/SPOR_WORK_ACCEPT); 'open' takes anything except readiness:human" },
      factory: { type: "string", value: "factory-id", desc: "the graph-resident factory definition whose gates every run must pass (default: work.factory; absent = bare loop)" },
      concurrency: { type: "string", value: "N", desc: "how many runs to keep in flight (default 1)" },
      interval: { type: "string", value: "S", desc: "seconds between polls (default 30)" },
      "max-interval": { type: "string", value: "S", desc: "backoff ceiling in seconds when idle (default 300)" },
      "retry-after": { type: "string", value: "S", desc: "seconds before retrying a refused item (default 600)" },
      "run-max": { type: "string", value: "H", desc: "hours to follow one run before freeing its slot (default 24)" },
      "run-idle": { type: "string", value: "M", desc: "minutes of silence (nothing written to a run's log or transcript) before stopping it as wedged (default 45; 0 disables)" },
      regate: { type: "string", value: "run-id", desc: "re-judge one refused run under the factory (after fixing what refused it) and exit" },
      max: { type: "string", value: "N", desc: "stop after N dispatches (default: run forever)" },
      once: { type: "boolean", desc: "one selection pass, wait for those runs, exit" },
      "restart-on-land": { type: "boolean", desc: "exit cleanly (after in-flight runs and pipelines settle) when the checkout this worker loaded its code from moves past that code, so a supervisor restarts it on the new code (also work.restartOnLand; self-hosting factories)" },
      status: { type: "boolean", desc: "read back this machine's workers instead of running one" },
      json: { type: "boolean", desc: "machine-readable status (with --status)" },
      profile: { type: "string", value: "profile-id", desc: "pin the profile every dispatch runs under" },
      model: { type: "string", value: "M", desc: "harness model override (otherwise profile.model)" },
      as: { type: "string", value: "agent-id", desc: "Spor agent IDENTITY to run as (overrides dispatch.agent; remote-only)" },
      agent: { type: "string", value: "A", desc: "claude --agent (harness agent DEFINITION — NOT the Spor identity; see --as)" },
      dir: { type: "string", value: "path", desc: "launch directory for every dispatch (overrides the slug map)" },
      template: { type: "string", value: "F", desc: "prompt template file (see 'spor help dispatch')" },
      "permission-mode": { type: "string", value: "P", desc: "claude --permission-mode" },
      sandbox: { type: "string", value: "S", desc: "codex exec --sandbox (default: workspace-write)" },
      "approval-policy": { type: "string", value: "P", desc: "codex exec --ask-for-approval (default: never)" },
      worktree: { type: "boolean", desc: "run every agent in its own git worktree (overrides dispatch.worktree)" },
      "no-worktree": { type: "boolean", desc: "force-disable worktree isolation" },
      "no-brief": { type: "boolean", desc: "raw task prompts, no briefing block" },
      full: { type: "boolean", desc: "full briefing instead of the digest" },
      "allow-person-token": { type: "boolean", desc: "fall back to a person-scoped token when no agent is configured or minting fails (default: hard-fail; also dispatch.allowPersonToken)" },
      print: { type: "boolean", desc: "dry run — show the scope, the pacing and the candidates; launch nothing" },
      "dry-run": DRYRUN_OPT,
    },
    examples: ["spor work", "spor work --project spor --concurrency 2", "spor work --factory factory-spor-default", "spor work --once --max 1 --print", "spor work --status --json"],
    run: (cfg, p) => cmdWork(cfg, p),
  },
  runs: {
    group: "Dispatch (background agents)", parse: "strict", args: "[<run-id>]",
    summary: "what happened to the runs this machine dispatched",
    help:
      "The durable record of every background agent dispatched from this machine —\n" +
      "how each run ENDED, and where to look (inc-spor-dispatch-session-vanished-\n" +
      "2026-07-18).\n\n" +
      "A supervised dispatch (the default for every built-in harness, including\n" +
      "Claude Code since it moved to 'claude -p' under the supervisor) has its\n" +
      "record finalized by the supervisor itself when the child exits. Only an\n" +
      "explicit 'spor dispatch --bg' still detaches into the Claude harness daemon,\n" +
      "where the launcher never sees the child exit and 'claude agents' lists only\n" +
      "what is still running: without this record a finished run and a dead one\n" +
      "are indistinguishable afterwards. Reading this reconciles those first —\n" +
      "every native-background run the harness no longer reports live is resolved\n" +
      "against its own transcript and stamped with a terminal state, a\n" +
      "classification, a reason, and a transcript pointer:\n\n" +
      "  done       the session ended its turn cleanly\n" +
      "  failed     it ended for a recognized reason (see the class)\n" +
      "  vanished   it stopped mid-turn with no end-of-turn marker — the reason\n" +
      "             names the last record and the transcript to read — or it left\n" +
      "             nothing that can be attributed to it\n" +
      "  failed_launch  the harness never started\n\n" +
      "Evidence is only ever this run's own: a transcript is matched by the\n" +
      "session the run bound, never by the directory it ran in, since several\n" +
      "dispatches can share one checkout. A run that never bound a session is\n" +
      "still made terminal, and says that its ending is unknown.\n\n" +
      "The classification separates causes that must not be conflated:\n" +
      "environment (provider credit exhaustion, usage limits, rate limits, rejected\n" +
      "auth — re-dispatch with headroom), launch, failed, completed, unknown.\n\n" +
      "A run still inside its first minute, or one whose harness could not be\n" +
      "queried at all, is left alone rather than declared dead. Terminal records\n" +
      "age out after dispatch.runRetentionMs (default 14d).",
    options: {
      node: { type: "string", value: "id", desc: "only runs dispatched for this node id" },
      limit: { type: "string", value: "N", desc: "how many runs to show (default 20)" },
      json: { type: "boolean", desc: "machine-readable JSON (the raw run records)" },
    },
    examples: ["spor runs", "spor runs --node issue-x", "spor runs --json"],
    run: (cfg, p) => cmdRuns(cfg, p),
  },
  repos: {
    group: "Dispatch (background agents)", parse: "raw",
    args: "[list | add <slug> <path> | rm <slug> | tags | tag <slug> [tag...] | untag <slug> [tag...]]",
    summary: "the local dispatch slug->dir map, plus repo-identity tags in the graph",
    help:
      "Two repo registers in one place.\n\n" +
      "The machine-local slug->repo-dir map dispatch uses to find a repo (self-\n" +
      "registers as you open sessions, lives in your user config.json):\n" +
      "  spor repos                 list the map\n" +
      "  spor repos add <slug> <p>  map a slug to a path\n" +
      "  spor repos rm <slug>       forget a mapping\n\n" +
      "Repo-identity TAGS on the repo-<slug> graph node — the match key for a norm's\n" +
      "applies_to_tags ride-along (schema-repo). An UNTAGGED repo excludes every tag-\n" +
      "scoped norm, so tagging is the deliberate opt-in that turns them on (dual-mode:\n" +
      "local rewrites the node file, remote does a put_node update):\n" +
      "  spor repos tags                   list every repo node with its slugs + tags\n" +
      "  spor repos tag <slug> <tag...>    set (replace) a repo's tags\n" +
      "  spor repos tag <slug>             show current tags + auto-suggest from disk\n" +
      "  spor repos untag <slug> [tag...]  remove tags (no tags clears all)",
    examples: ["spor repos", "spor repos add api ~/code/api", "spor repos tag spor-server python backend", "spor repos tags"],
    run: (cfg, args) => cmdRepos(cfg, args),
  },
  capabilities: {
    group: "Dispatch (background agents)", parse: "raw", aliases: ["caps", "profiles"],
    args: "[list [--json] | show <agent-id> | probe | publish | hosts <profile-id> | set <axis> <v...> | allow-mcp <m...> | deny <profile-id...> | clear]",
    summary: "this machine's dispatch capability map (profile satisfiability)",
    help:
      "Show or edit the per-machine capability map dispatch matches against an\n" +
      "agent's profile (dec-spor-machine-profile-satisfiability). Harnesses, plugins,\n" +
      "and skills self-probe each session; declare what a probe can't decide (reachable\n" +
      "MCP, deny-flags). Declared augments probed; deny overrides both. Stored in the\n" +
      "machine-local config.json, never a committed .spor.json.\n\n" +
      "  spor capabilities                  show THIS box's effective capabilities\n" +
      "  spor capabilities show <agent>     read an agent's PUBLISHED fleet caps (remote)\n" +
      "  spor capabilities probe            re-probe harnesses/plugins/skills now\n" +
      "  spor capabilities publish          push them to the team fleet scheduler (remote)\n" +
      "  spor capabilities hosts <profile>  which fleet boxes satisfy a profile (remote)\n" +
      "  spor capabilities set <axis> <v…>  declare an axis (replaces)\n" +
      "  spor capabilities add|rm <axis> <v…>  adjust a declared axis\n" +
      "  spor capabilities allow-mcp <name…>   declare a reachable MCP server\n" +
      "  spor capabilities deny|undeny <profile-id…>  policy opt-out of a profile\n" +
      "  spor capabilities clear            reset declarations + probe cache\n\n" +
      "publish is the remote twin: it sends this box's effective capabilities to the\n" +
      "server (keyed on dispatch.agent) so the fleet scheduler can route an assigned\n" +
      "profile to a box that can satisfy it — substitution-free re-routing across\n" +
      "machines. Run `spor agent use <agent-id>` once to set this box's agent first.\n" +
      "Once an agent is set, session-start auto-publishes each session (remote mode),\n" +
      "so manual publish is rarely needed; SPOR_CAPABILITIES_PUBLISH=0 disables it.\n\n" +
      "show <agent-id> is publish's read twin: it reads back what a SPECIFIC box\n" +
      "advertised (caps + published_at/last_seen/published_by) without raw REST.\n" +
      "Readable by the agent's owner, the agent itself, or an admin. Pass `me` to read\n" +
      "this box's own published record (its dispatch.agent) — to compare what the fleet\n" +
      "stored against what `spor capabilities` computes locally.\n\n" +
      "hosts is the read side of that scheduler: it host-matches a profile against the\n" +
      "fleet and lists the boxes that can run it (re-route targets) and those that\n" +
      "can't, with reasons. `spor dispatch` also prints these automatically when THIS\n" +
      "box can't satisfy a profile, so you know exactly where to re-route — or that\n" +
      "none can and the owner must be escalated (FORK B: never a substitute).\n" +
      "Scope with --owner me|person-X; demote stale publishes with --max-age 30m|12h|7d.\n\n" +
      `  axes: ${sat.CAP_AXES.join(", ")}`,
    examples: ["spor capabilities", "spor capabilities allow-mcp spor", "spor capabilities publish", "spor capabilities show agent-anthony-laptop", "spor capabilities hosts profile-docs-writer"],
    run: (cfg, args) => cmdCapabilities(cfg, args),
  },

  // --- Other ---
  cost: {
    group: "Other", parse: "raw", args: "[--since D]",
    summary: "LLM spend summary from journal/llm-calls (local)",
    help: "Summarize recorded LLM spend from journal/llm-calls. Byte-identical\npassthrough to lib/cost.js.",
    options: {
      since: { type: "string", value: "YYYY-MM-DD", desc: "include calls on/after this date" },
      until: { type: "string", value: "YYYY-MM-DD", desc: "include calls on/before this date" },
      project: { type: "string", value: "slug", desc: "scope to a project" },
      json: { type: "boolean", desc: "machine-readable JSON output" },
    },
    examples: ["spor cost", "spor cost --since 2026-06-01"],
    run: (cfg, args) => passthrough("cost.js", args),
  },
  version: {
    group: "Other", parse: "meta", args: "", summary: "print version",
    run: () => 0,
  },
  help: {
    group: "Other", parse: "meta", args: "[<command>]", summary: "this message, or a command's detailed help",
    run: () => 0,
  },
};

const GROUP_ORDER = [
  "Getting started",
  "Team admin (remote, admin token)",
  "Graph",
  "Repo scoping",
  "Dispatch (background agents)",
  "Other",
];

// alias -> canonical verb (every canonical maps to itself).
const ALIAS_TO_CANON = (() => {
  const m = {};
  for (const [name, e] of Object.entries(COMMANDS)) {
    m[name] = name;
    for (const a of e.aliases || []) m[a] = name;
  }
  return m;
})();
function resolveVerb(v) {
  return Object.prototype.hasOwnProperty.call(ALIAS_TO_CANON, v) ? ALIAS_TO_CANON[v] : null;
}

// Build the parseArgs options descriptor from a table entry's options, dropping
// the help-only keys (desc/value) so only {type, short, multiple} reach parseArgs.
function paOptions(options) {
  const o = {};
  for (const [name, spec] of Object.entries(options || {})) {
    o[name] = { type: spec.type };
    if (spec.short) o[name].short = spec.short;
    if (spec.multiple) o[name].multiple = true;
  }
  return o;
}

// Closest candidate by edit distance, for "did you mean --foo?" hints.
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
function suggest(word, candidates) {
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(word, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return bestD <= Math.max(2, Math.ceil(word.length / 3)) ? best : null;
}

// Turn a parseArgs throw into a friendly, no-stack-trace error + a flag hint.
function parseError(e, entry, verb) {
  const m = /'(-{1,2}[^']+)'/.exec(e.message || "");
  if (e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && m) {
    err(`spor ${verb}: unknown flag '${m[1]}'`);
    const s = suggest(m[1].replace(/^-+/, ""), Object.keys(entry.options || {}));
    if (s) err(`  did you mean --${s}?`);
    err(`  run 'spor ${verb} --help' for the flag list.`);
    return 1;
  }
  err(`spor ${verb}: ${e.message}`);
  err(`  run 'spor ${verb} --help' for usage.`);
  return 1;
}

// The top-level listing, generated from the table so it can't drift.
function renderTopHelp() {
  const verbs = Object.keys(COMMANDS);
  const sigOf = (v) => `${v}${COMMANDS[v].args ? " " + COMMANDS[v].args : ""}`;
  const width = Math.min(22, Math.max(...verbs.map((v) => sigOf(v).length)));
  const lines = [HELP_HEADER, ""];
  for (const group of GROUP_ORDER) {
    const inGroup = verbs.filter((v) => COMMANDS[v].group === group);
    if (!inGroup.length) continue;
    lines.push(group);
    for (const v of inGroup) lines.push(`  ${sigOf(v).padEnd(width)}  ${COMMANDS[v].summary}`);
    lines.push("");
  }
  lines.push(HELP_FOOTER);
  return lines.join("\n");
}

// One command's detailed page (usage, aliases, description, flags, examples).
function renderCmdHelp(verb) {
  const e = COMMANDS[verb];
  const opts = Object.entries(e.options || {});
  const sig = `spor ${verb}${e.args ? " " + e.args : ""}${opts.length ? " [options]" : ""}`;
  const lines = [sig, "", e.summary];
  if (e.aliases && e.aliases.length) lines.push(`Aliases: ${e.aliases.join(", ")}`);
  if (e.help) lines.push("", e.help);
  if (opts.length) {
    const rendered = opts.map(([name, o]) => [`--${name}${o.type === "string" ? ` <${o.value || "value"}>` : ""}`, o.desc || ""]);
    const w = Math.min(26, Math.max(...rendered.map((r) => r[0].length)));
    lines.push("", "Options:");
    for (const [flag, desc] of rendered) lines.push(`  ${flag.padEnd(w)}  ${desc}`);
  }
  if (e.examples && e.examples.length) {
    lines.push("", "Examples:");
    for (const ex of e.examples) lines.push(`  ${ex}`);
  }
  return lines.join("\n");
}

// `--org <slug>` / `--org=<slug>` is a GLOBAL tenant selector (it picks which
// stored credential any verb talks to — dec-spor-client-cli-mode-tenant-
// resolution), lifted out of the per-verb argv so the strict parser never sees
// it. No existing verb uses --org, so this is safe to strip everywhere; the auth
// verbs read it back via Config.flagOrg().
function extractOrgFlag(argv) {
  const rest = [];
  let org = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--org") {
      if (argv[i + 1] != null && !argv[i + 1].startsWith("--")) {
        org = argv[i + 1];
        i++;
      }
      continue;
    }
    const m = /^--org=(.*)$/.exec(a);
    if (m) {
      org = m[1];
      continue;
    }
    rest.push(a);
  }
  return { org, rest };
}

// The verbs exempt from the unknown-`--org` refusal below: the credential
// namespace, whose whole job is to ACQUIRE a credential for an org you do not
// have one for yet (`spor auth login --org <new>`, `spor join … --org <new>`),
// and to list/switch/clear what is stored — i.e. the place you go to FIX the
// refusal. Everything else refuses (issue-spor-cli-unrecognized-org-fallback).
const TENANT_VERBS = new Set(["auth", "join", "login"]);

// A global `--org` that names no stored credential must REFUSE the command, not
// quietly run it against the active tenant: a read then answers from the wrong
// graph, and a write LANDS in it while the operator believes they are scoped
// elsewhere (issue-spor-cli-unrecognized-org-fallback). lib/config.js already
// declines to fall through — it reports the refusal instead of resolving a
// tenant — so all that is left here is to say so and exit non-zero rather than
// running the verb in the local mode that null tenant resolves to.
function refuseUnknownOrg(cfg, canon) {
  const te = cfg.tenantError();
  if (!te || te.kind !== "unknown-org" || TENANT_VERBS.has(canon)) return false;
  err(`spor: no credential stored for org '${te.org}' — refusing to run against a different tenant.`);
  err(te.orgs.length ? `  stored orgs: ${te.orgs.join(", ")}` : "  the credential store is empty");
  err(`  run 'spor auth login --org ${te.org}' to add one, or 'spor auth list' to see them.`);
  return true;
}

async function main() {
  const { org: cliOrg, rest: argv } = extractOrgFlag(process.argv.slice(2));
  const verb = argv.shift();
  const args = argv;
  const cfg = loadConfig({ cwd: process.cwd(), cli: cliOrg ? { org: cliOrg } : undefined });

  // Top-level help / version are intercepted before table dispatch. `spor help
  // <command>` prints that command's detailed page.
  if (verb === undefined || verb === "help" || verb === "-h" || verb === "--help") {
    const topic = verb === "help" && args[0] ? resolveVerb(args[0]) : null;
    out(topic && COMMANDS[topic].parse !== "meta" ? renderCmdHelp(topic) : renderTopHelp());
    return 0;
  }
  if (verb === "version" || verb === "--version" || verb === "-v") {
    out(version());
    return 0;
  }

  const canon = resolveVerb(verb);
  if (!canon || COMMANDS[canon].parse === "meta") {
    err(`spor: unknown verb '${verb}'. Try 'spor help'.`);
    return 1;
  }
  const entry = COMMANDS[canon];

  // `spor <command> --help|-h` => the command's own page.
  if (args.includes("--help") || args.includes("-h")) {
    out(renderCmdHelp(canon));
    return 0;
  }

  // Checked after help/version (asking what a verb does needs no tenant) and
  // before any verb runs, so an unknown `--org` can neither read nor write.
  if (refuseUnknownOrg(cfg, canon)) return 1;

  if (entry.parse === "raw") return await entry.run(cfg, args, verb);

  // strict: util.parseArgs is the parser; a parse failure is a friendly error.
  let parsed;
  try {
    parsed = parseArgs({ args, options: paOptions(entry.options), allowPositionals: true, strict: true });
  } catch (e) {
    return parseError(e, entry, canon);
  }
  return await entry.run(cfg, parsed, verb);
}

// Expose the pure helpers for unit tests (the version-check logic has no I/O),
// and only run the CLI when invoked directly — requiring this file must not
// kick off main() and call process.exit under the test runner.
module.exports = { loadedCodeCommit, makeCodeMovedNotice, codeWatchRef, gateRescueDiagnosis, rescueDiagnosisPath, excludeRescueDiagnosisDir, nodeFloor, nodeRuntimeCheck, nodeConfirmedAbsent, verCmp, sporConnectorBound, hasCmd, COMMANDS, resolveVerb, getNodeJson, gitBlobSha, refreshAgentsBlockIfManaged, gateApprovalState, gateIdSuffix, writeGateNode, buildGateWorkNode, gateDemoteItem, gatePromoteItem, blockerAlreadyClosed, proposalSettledMeanwhile, restoreProposal, checkProposals, healProposalTracking, proposalTrackingId, buildProposalTrackingNode, setStatusLocal, makeGateDeps, makeIntegrationDeps, runGateAndIntegration, acquireLocalIntegrationLease, releaseLocalIntegrationLease, integrationLeaseKey, loadFactoryDefinition, runSupervisorAlive, workerAlive, pollWorkRuns, nativeAgentEvidence, verifyRunResolution, proposeIntegrationPR, ghPrStatus, integrationSatisfiability };

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code || 0;
    })
    .catch((e) => {
      err(`spor: ${e && e.message ? e.message : String(e)}`);
      process.exitCode = 1;
    });
}
