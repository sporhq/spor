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
const { spawnSync } = require("child_process");
const { parseArgs } = require("util");

const ROOT = path.resolve(__dirname, "..");
const { loadConfig, DEFAULT_SERVER } = require(path.join(ROOT, "lib", "config.js"));
const remote = require(path.join(ROOT, "lib", "remote.js"));
const auth = require(path.join(ROOT, "lib", "auth.js"));
const u = require(path.join(ROOT, "scripts", "engines", "util.js"));
const sat = require(path.join(ROOT, "lib", "kernel", "satisfiability.js"));
// Resolution truth (lib/kernel/resolution.js): a node is "done" when it carries a
// TERMINAL status OR a live inbound resolves/answers edge — the same partition the
// queue ranker and read surfaces use. The dispatch guard reads it so it never
// launches an agent at already-finished work (issue-spor-dispatch-resolved-task-no-guard).
const { isTerminalStatus, resolutionOf } = require(path.join(ROOT, "lib", "kernel", "resolution.js"));
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
function err(s) {
  process.stderr.write(s + "\n");
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
    const r = spawnSync("git", ["init", "-q"], { cwd: home, stdio: "ignore" });
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

async function cmdStatus(cfg) {
  const mode = cfg.mode();
  const home = cfg.graphHome();
  const nodesDir = cfg.nodesDir();
  const slug = safeSlug();
  out(`mode:     ${mode}${cfg.enabled() ? "" : "  (not enabled here — run /spor:onboard to set up, or 'spor enable' to opt in; hooks are a no-op)"}`);
  out(`project:  ${slug}`);
  if (mode === "remote") {
    const server = remote.base(cfg);
    out(`server:   ${server}`);
    const probe = await remote.get(cfg, "/v1/status", { timeoutMs: 6000 });
    if (probe.transport) out(`health:   OFFLINE — could not reach server (${probe.error})`);
    else if (probe.status === 401 || probe.status === 403) out(`health:   AUTH FAILED (${probe.status}) — token invalid, revoked, or expired`);
    else if (!probe.ok) out(`health:   error ${probe.status}`);
    else {
      const n = probe.json && probe.json.node_count;
      out(`health:   OK${n != null ? ` (${n} nodes)` : ""}`);
    }
    out(`token:    ${remote.token(cfg) ? "present" : "MISSING"}`);
    const who = await identity(cfg);
    out(`identity: ${who}`);
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
    if (sporConnectorBound()) {
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
  const plugin = claudePluginInfo();
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
    const bound = r.json.bound;
    const admin = r.json.is_admin ? "  (admin)" : "";
    if (bound && p) return `${p}${r.json.email ? ` <${r.json.email}>` : ""}${admin}`;
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
    const qs = new URLSearchParams();
    if (scopeSlug) qs.set("project", scopeSlug);
    if (inclTypes.length) qs.set("type", inclTypes.join(","));
    if (exclTypes.length) qs.set("exclude_type", exclTypes.join(","));
    // Page size (task-spor-next-limit-flag): --limit N defaults to DEFAULT_LIMIT
    // (20), --limit 0 means "all". fetchQueuePaged sets ?limit (+?offset) per page
    // and walks next_offset to assemble the target, so the limit is never set on
    // qs here.
    const r = await fetchQueuePaged(cfg, qs, queueLimitTarget(args));
    if (r.transport) {
      err(`offline — could not reach server (${r.error})`);
      return 1;
    }
    if (!r.ok) {
      err(`queue error ${r.status}`);
      return 1;
    }
    // Best-effort zero-match note (issue-spor-next-project-token-not-roundtrippable):
    // unknown-token detection is authoritative only locally (where we hold the
    // graph); remotely we can only observe an empty result for a SCOPED read and
    // softly say so on stderr. The cwd-default firehose (no explicit/pinned scope)
    // and an explicit --all-projects are deliberately not flagged — an empty
    // result there is normal, not a typo.
    const scoped = (allProjects && !explicit) ? null : (explicit ?? pinned);
    const count = (r.json && (r.json.count ?? (Array.isArray(r.json.items) ? r.json.items.length : null)));
    if (scoped && count === 0) {
      err(`project '${scoped}' returned an empty queue — check the slug / grouping id (the server scoped to it and found nothing)`);
    }
    if (needAgents) {
      const q = r.json || {};
      const { items, hidden } = annotateInFlight(q.items || [], dispatchedAgents(), hideDispatched);
      q.items = items;
      if (typeof q.count === "number") q.count = Math.max(0, q.count - hidden);
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
  return nextLocalInFlight(localArgs, { wantJson, hideDispatched });
}

// Local in-flight surface (task-spor-cli-in-flight-surface). The default local
// `next` is a byte-identical passthrough to lib/queue.js; when --json or
// --hide-dispatched asks for the agent-aware view we run queue.js with --json,
// capture its ranked result, cross-reference dispatchedAgents(), and re-emit.
// queue.js's stderr (e.g. the unknown-project note) is inherited so it still
// surfaces; an unparseable stdout falls back to forwarding it verbatim, so an
// error path is never swallowed. The flags are presentation-only — strip them
// before handing argv to queue.js (which doesn't know them) and force --json.
function nextLocalInFlight(localArgs, { wantJson, hideDispatched }) {
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
  const { items, hidden } = annotateInFlight(q.items || [], dispatchedAgents(), hideDispatched);
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
function dispatchedAgents() {
  try {
    let text = process.env.SPOR_FAKE_AGENTS_JSON;
    if (text == null) {
      const cmd = claudeCmd();
      if (cmd === "claude" && !hasCmd("claude")) return new Map();
      const r = spawnSync(cmd, ["agents", "--json"], { encoding: "utf8", timeout: 5000 });
      if (r.status !== 0 || !r.stdout) return new Map();
      text = r.stdout;
    }
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return new Map();
    const map = new Map();
    for (const a of arr) {
      if (!a || a.kind !== "background" || typeof a.name !== "string") continue;
      if (a.state === "done") continue; // finished — not in flight
      const list = map.get(a.name) || [];
      // sessionId + startedAt ride along for post-launch session capture
      // (dec-spor-dispatch-bg-session-late-bind); the dup-guard ignores them.
      list.push({ id: a.id, name: a.name, state: a.state, status: a.status, cwd: a.cwd, sessionId: a.sessionId, startedAt: a.startedAt });
      map.set(a.name, list);
    }
    return map;
  } catch {
    return new Map();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Find the FULL run-session id of the agent `spor dispatch` just launched in `dir`
// (dec-spor-dispatch-bg-session-late-bind). `claude --bg` self-allocates and
// prints only a SHORT id, but `claude agents --json` reports the full `sessionId`
// + `cwd` + `startedAt` — the reliable capture path. Match on cwd (the strong
// signal — we just launched there), then on name when given, then pick the NEWEST
// (the run we just started). Returns the sessionId or null.
function newestDispatchedSession(name, dir) {
  const all = [];
  for (const arr of dispatchedAgents().values()) for (const a of arr) all.push(a);
  let cands = all.filter((a) => a.sessionId && (!dir || a.cwd === dir));
  if (name) {
    const named = cands.filter((a) => a.name === name);
    if (named.length) cands = named;
  }
  if (!cands.length) return null;
  cands.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return cands[0].sessionId;
}

// Capture the launched run's session, polling briefly while the daemon registers
// it. SPOR_SESSION_ID pins it (tests/reproducibility) and short-circuits the poll.
// Returns the sessionId or null (fail-open — the caller degrades to session-null).
async function captureDispatchSession(name, dir, pinned) {
  if (pinned) return pinned;
  for (let i = 0; i < 6; i++) {
    const sid = newestDispatchedSession(name, dir);
    if (sid) return sid;
    await sleep(300);
  }
  return null;
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

// Page through GET /v1/queue assembling up to `target` items (Infinity = all)
// (task-spor-next-limit-flag). The server caps each page at 100 (API.md §5) and
// reads limit 0 as its own default, so "all" — and any finite N>100 — must be
// assembled client-side: request pages of <=100 over `offset`, following
// `next_offset` until we have `target` items or the pages run out. The full-set
// aggregates (count, counts_by_*, questions/findings/…) are identical on every
// page (the server ranks the whole set and slices only the page), so we keep the
// FIRST page's envelope and just grow its .items. A finite limit <=100 is a
// single request — byte-compatible with the old hardcoded read. Returns the
// failing remote.get result verbatim on transport/HTTP error so the caller's
// existing checks fire.
async function fetchQueuePaged(cfg, baseQs, target) {
  const items = [];
  let envelope = null;
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
    const pageItems = Array.isArray(page.items) ? page.items : [];
    items.push(...pageItems);
    const next = page.next_offset;
    if (next == null || pageItems.length === 0 || next <= offset) break;
    offset = next;
  }
  envelope = envelope || { items: [], count: 0 };
  envelope.items = target === Infinity ? items : items.slice(0, target);
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
// node (GET /v1/nodes/<id>) plus a title/summary-seeded /v1/digest for its
// neighborhood, concatenated. Shared by compileRemote (brief / compile --root)
// and compileBriefing (dispatch) so the two can't drift — dispatch used to
// embed only the bare node, a thinner standing context than an interactive
// brief (issue-spor-dispatch-briefing-omits-neighborhood). Returns
// {transport,error} | {ok:false,status} | {ok:true,status,text}; the
// neighborhood is fail-soft (a failed/empty digest just yields the raw node).
async function remoteNodeBriefing(cfg, { root, project }) {
  const r = await remote.get(cfg, `/v1/nodes/${encodeURIComponent(root)}`, { timeoutMs: 8000 });
  if (r.transport) return { transport: true, error: r.error, text: "" };
  if (!r.ok) return { ok: false, status: r.status, text: "" };
  const raw = (r.json && r.json.raw) || r.text || "";
  // Seed the neighborhood digest from the node's own title/summary (the REST
  // /v1/digest is query-mode only — root compile is not exposed over REST).
  const seed = (r.json && (r.json.title || r.json.summary)) || fmField(raw, "title") || fmField(raw, "summary") || root;
  const d = await remote.post(cfg, "/v1/digest", project ? { query: seed, project } : { query: seed }, { timeoutMs: 8000 });
  const neighborhood = d.ok && d.json && d.json.found !== false ? d.json.text || "" : "";
  return { ok: true, status: r.status, text: neighborhood ? `${raw}\n\n${neighborhood}` : raw };
}

// The remote arm of compile/brief. Mirrors the /spor:brief skill's remote
// resolution: a node id -> the raw node plus a title/summary-seeded /v1/digest
// for its neighborhood; free text -> POST /v1/digest. --skeleton has no server
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
  const flagValIdx = new Set();
  for (let i = 0; i < args.length; i++) if (args[i] === "--nodes" || args[i] === "--source") flagValIdx.add(i + 1);
  const type = args.find((a, i) => !a.startsWith("--") && !flagValIdx.has(i)) || null;
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
  return res.code;
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
    err('usage: spor add "<text>" [--type T] [--title ...] [--project S] [--during ID] [--blocks ID] [--needed-by YYYY-MM-DD]');
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

  if (cfg.mode() === "remote") {
    const context = { project };
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
    const body = { text: prose, context, idempotency_key: crypto.randomUUID() };
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
    out(ids.length ? `captured: ${ids.join(", ")}` : `captured (${(r.json && r.json.status) || "ok"})`);
    // Self-heal: a pure-CLI user has no Claude Code session to run the drain, so a
    // successful capture (proof the server is reachable) is the moment to flush any
    // backlog the fail-open spool stranded (task-spor-cli-outbox-drain-verb). Only
    // runs when there IS a spool, is bounded, and never affects the add's success.
    await opportunisticDrain(cfg);
    return 0;
  }

  // local: hand the user a typed, validated node file
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  const nodesDir = cfg.nodesDir();
  if (!fs.existsSync(nodesDir)) {
    err(`no graph at ${nodesDir} — run 'spor init' first`);
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
  const md = `---\nid: ${id}\ntype: ${type}\nrepo: ${project}\ntitle: ${title.replace(/\n/g, " ")}\nsummary: ${summary.replace(/\n/g, " ")}\n${neededByLine}${edgesBlock}date: ${today()}\n---\n\n${prose}\n`;
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
  out(`added ${id} (${type}) to ${nodesDir}`);
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
  const slug = project || safeSlug();
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
  out(`question filed: ${id} (open) in ${nodesDir}`);
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
  out(`correction created: ${id} (targets ${target}) in ${nodesDir}`);
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
    const r = spawnSync("git", ["-C", repoDir, "config", key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 ? (r.stdout || "").trim() : "";
  };
  return { name: read("user.name"), email: read("user.email") };
}

// Rewrite a node's raw markdown to carry `value` (or clear it when value is ""),
// stamping priority_by/_at/_via. Byte-mirrors the server's rewritePriority so a
// local node and a remote one read the same after the mutation; returns the new
// raw, or null when the frontmatter can't be located.
function rewritePriority(raw, value, identity, via) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  let fm = m[1];
  const body = m[2];
  const stripFmLine = (s, key) => s.replace(new RegExp(`(^|\\n)${key}:[^\\n]*`, "g"), "");
  for (const k of ["priority", "priority_by", "priority_at", "priority_via"]) fm = stripFmLine(fm, k);
  fm = fm.replace(/\n+$/, "").replace(/^\n+/, "");
  const stamps = [];
  if (value) {
    stamps.push(`priority: ${value}`);
    if (identity && identity.name && identity.email) stamps.push(`priority_by: ${identity.name} <${identity.email}>`);
    stamps.push(`priority_at: ${u.isoMs()}`);
    stamps.push(`priority_via: ${via}`);
  }
  const fmOut = stamps.length ? `${fm}\n${stamps.join("\n")}` : fm;
  return `---\n${fmOut}\n---\n${body}`;
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
  const value = norm.value;

  if (cfg.mode() === "remote") {
    // Send the canonical value the server validates again; it stamps
    // priority_by/_at/_via (via: rest) from the token, so the body is {priority}.
    const r = await remote.post(cfg, `/v1/nodes/${encodeURIComponent(id)}/priority`, { priority: value }, { timeoutMs: 8000 });
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
      err(`priority error ${r.status}${msg ? `: ${msg}` : ""}`);
      return 1;
    }
    out(value ? `priority set: ${id} -> ${value}` : `priority cleared: ${id}`);
    return 0;
  }

  // local: rewrite the node file's frontmatter in place, mirroring the server's
  // read-modify-write (no server to POST to). Identity is the git user the way
  // local $viewer is derived (lib/queue.js viewerFor), the door is `cli`.
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
  const newRaw = rewritePriority(raw, value, identity, "cli");
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
    err(`invalid node after priority rewrite: ${e.message}`);
    return 1;
  }
  const v = graphLib.validateNode(g, node);
  if (!v.ok) {
    err(`invalid node after priority rewrite:\n  ${v.errors.join("\n  ")}`);
    return 1;
  }
  fs.writeFileSync(file, newRaw);
  out(value ? `priority set: ${id} -> ${value}` : `priority cleared: ${id}`);
  return 0;
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
    const lease = r.json && r.json.lease;
    if (lease) {
      if (lease.error) err(`  note: not claimed (${lease.error}${lease.holder ? `, held by ${lease.holder}` : ""})`);
      else out(`  claimed${lease.expires_at ? ` (lease expires ${lease.expires_at})` : ""}`);
    }
    return 0;
  }

  // local: rewrite the node file's status frontmatter in place, mirroring the
  // server's read-modify-write (no server to POST to, no lease to take). When the
  // type's schema declares a status enum, reject an out-of-vocabulary value the
  // same way the server's setStatus does (registry is the contract); types whose
  // vocabulary lives in a sandbox validate() fn aren't enum-checked here, exactly
  // as the server's membership check skips them.
  const graphLib = require(path.join(ROOT, "lib", "graph.js"));
  const nodesDir = cfg.nodesDir();
  const file = path.join(nodesDir, `${id}.md`);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    err(`no such node: ${id}`);
    return 1;
  }
  let g;
  try {
    g = graphLib.loadGraph(nodesDir);
  } catch (e) {
    err(`could not load graph: ${e.message}`);
    return 1;
  }
  const type = g.nodes[id] && g.nodes[id].type;
  const schema = type && g.registry.nodeSchemas ? g.registry.nodeSchemas.get(type) : null;
  const allowed = schema && schema.payload && schema.payload.fields && schema.payload.fields.status && schema.payload.fields.status.enum;
  if (Array.isArray(allowed) && !allowed.includes(value)) {
    err(`status '${value}' not allowed for type '${type}' — allowed: ${allowed.join(", ")}`);
    return 1;
  }
  const newRaw = rewriteStatus(raw, value);
  if (newRaw == null) {
    err(`could not locate frontmatter in ${id}`);
    return 1;
  }
  let node;
  try {
    node = graphLib.parseFrontmatter(newRaw, `${id}.md`);
  } catch (e) {
    err(`invalid node after status rewrite: ${e.message}`);
    return 1;
  }
  const v = graphLib.validateNode(g, node);
  if (!v.ok) {
    err(`invalid node after status rewrite:\n  ${v.errors.join("\n  ")}`);
    return 1;
  }
  fs.writeFileSync(file, newRaw);
  out(`status set: ${id} -> ${value}`);
  return 0;
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
  if (lease.by) parts.push(`held by ${lease.by}`);
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
  const server = auth.normServer(serverFlag || cfg.server() || DEFAULT_SERVER);
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
    person = values.id || `person-${kebab(name)}`;
    const md = `---\nid: ${person}\ntype: person\ntitle: ${name.replace(/\n/g, " ")}\nsummary: Team member ${name}.\nemail: ${email}\ndate: ${today()}\n---\n\nTeam member ${name} <${email}>.\n`;
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
    out(`person node ${person} ${res0 && res0.status === "skipped" ? "(already existed)" : "created"}`);
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
  out(`minted token for ${j.person} <${j.email}>${j.expires ? ` (expires ${j.expires})` : ""} [${j.hash_prefix}]`);
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
    id = `${prefix}${kebab(name)}`;
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
  out(`created person ${id} <${email}>`);
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
    out(`${p.id}\t${p.email || "(no email)"}\t${p.title || ""}${me}`);
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

// `spor agent use <agent-id>` — make this agent the machine's default dispatch
// identity by writing `dispatch.agent` to the USER config.json (the same
// machine-local, never-committed file as the repo map; per-machine, like
// dispatch.repos). This is the real setter the create/list hints point to;
// before it, dispatch.agent was settable only via env or by hand-editing the
// config. `spor agent use --clear` (or an empty id) drops back to person-scoped
// dispatch. Not a graph write — purely local config, so it works in both modes.
function cmdAgentUse(cfg, { id }) {
  const clear = id === "--clear" || id === "none" || id === "";
  if (!id) {
    err("usage: spor agent use <agent-id>   (or: spor agent use --clear)");
    return 1;
  }
  if (!clear && !isAgentId(id)) {
    err(`invalid agent id '${id}' — must be an 'agent-<slug>' kebab id (e.g. agent-your-machine)`);
    const guess = agentIdGuess(id);
    if (guess) err(`  did you mean '${guess}'?  ('spor agent list' shows the full id — the 'agent-' prefix is part of it, not the label)`);
    return 1;
  }
  const home = cfg.userConfigHome();
  const wrote = u.setDispatchAgent(home, clear ? null : id);
  if (clear) {
    out(wrote ? "cleared dispatch.agent — dispatches run person-scoped again" : "dispatch.agent was already unset");
    return 0;
  }
  if (wrote) {
    out(`dispatch.agent = ${id}  (this machine now dispatches as ${id}; ${path.join(home, "config.json")})`);
  } else {
    out(`dispatch.agent already = ${id} (no change)`);
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
  out(`created agent ${id}${j.owner ? ` owned by ${j.owner}` : ""}`);
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
      err(`several person nodes — name the owner with --owner (one of: ${people.map((p) => p.id).slice(0, 6).join(", ")}${people.length > 6 ? ", …" : ""})`);
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
  out(`created agent ${id} owned by ${ownerId}`);
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
    const rows = a.json.agents.map((ag) => `${ag.id}\t${ag.owner ? `owned-by ${ag.owner}` : (ag.title || "")}\t${ag.status || "active"}`);
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
    out(`${a.id}\t${ownedBy ? `owned-by ${ownedBy.to}` : "(no owner)"}\t${status}`);
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
  out(`minted standing PAT for ${j.agent || agent}${j.owner ? ` (owned by ${j.owner})` : ""}${j.label ? ` [${j.label}]` : ""}${j.expires ? ` (expires ${j.expires})` : ""} [${j.hash_prefix}]`);
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
  out(`minted personal access token for ${j.person}${j.email ? ` <${j.email}>` : ""}${j.label ? ` [${j.label}]` : ""}${j.expires ? ` (expires ${j.expires})` : ""} [${j.hash_prefix}]`);
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
    out(`${t.hash_prefix}  ${t.person || t.email || "?"}${t.expired ? "  EXPIRED" : ""}${t.expires ? `  (expires ${t.expires})` : ""}`);
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
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
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
// r.error, handled by hasGit() before we get here).
function git(cwd, gitArgs, opts = {}) {
  return spawnSync("git", gitArgs, { cwd, encoding: "utf8", ...opts });
}
function hasGit() {
  return !spawnSync("git", ["--version"]).error;
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
  codex: { kind: "hooks", label: "Codex CLI", src: ["adapters", "codex", "hooks.json"], user: [".codex", "hooks.json"], repo: [".codex", "hooks.json"] },
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
// same lever 'spor dispatch' uses). All claude shell-outs route through here.
function claudeCmd() {
  return process.env.SPOR_CLAUDE_CMD || "claude";
}

// The spor plugin Claude Code has LOADED (its own cached copy under
// ~/.claude/plugins/), parsed from `claude plugin list --json`, or null if the
// claude CLI is absent / spor isn't installed. Fail-soft and bounded — never
// throws, prints, or hangs — so it is safe to call on the status path.
function claudePluginInfo() {
  const cmd = claudeCmd();
  if (cmd === "claude" && !hasCmd("claude")) return null;
  const r = spawnSync(cmd, ["plugin", "list", "--json"], { encoding: "utf8", timeout: 8000 });
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
function sporConnectorBound() {
  try {
    let text = process.env.SPOR_FAKE_MCP_LIST;
    if (text == null) {
      const cmd = claudeCmd();
      if (cmd === "claude" && !hasCmd("claude")) return false;
      const r = spawnSync(cmd, ["mcp", "list"], { encoding: "utf8", timeout: 8000 });
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

function readJsonOr(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) || fallback;
  } catch {
    return fallback;
  }
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

function hasCmd(cmd) {
  try {
    return !spawnSync(cmd, ["--version"], { stdio: "ignore" }).error;
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
function refreshClaudePlugin(cmd, cliScope, before) {
  spawnSync(cmd, ["plugin", "marketplace", "update", "spor"], { encoding: "utf8" });
  // Claude Code resolves an installed plugin by its name@marketplace id (the
  // install side uses 'spor@spor'); the bare 'spor' is unresolvable and fails
  // with "Plugin 'spor' not found" (issue-spor-upgrade-wrong-plugin-marketplace-id).
  const upd = spawnSync(cmd, ["plugin", "update", "spor@spor", "--scope", cliScope], { stdio: "inherit" });
  if (upd.status !== 0) {
    err(`claude plugin update failed (exit ${upd.status == null ? "?" : upd.status})`);
    return 1;
  }
  const after = claudePluginInfo();
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
function installClaude(scope, dryRun) {
  const cmd = claudeCmd();
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
  const add = spawnSync(cmd, addArgs, { encoding: "utf8" });
  if (add.status !== 0 && !/already|exists|known/i.test((add.stderr || "") + (add.stdout || ""))) {
    err(`claude plugin marketplace add failed: ${(add.stderr || add.stdout || "").trim() || "unknown error"}`);
    return 1;
  }
  const existing = claudePluginInfo();
  if (existing) return refreshClaudePlugin(cmd, cliScope, existing);
  const inst = spawnSync(cmd, instArgs, { stdio: "inherit" });
  if (inst.status !== 0) {
    err(`claude plugin install failed (exit ${inst.status == null ? "?" : inst.status})`);
    return 1;
  }
  out(`installed spor@spor into Claude Code (scope: ${cliScope}) — no marketplace browsing needed.`);
  return 0;
}

// JSON-hook hosts (codex/cursor/copilot/gemini): render + merge into the target.
function installHookHost(spec, scope, dryRun) {
  const target = targetPath(spec, scope);
  const merged = mergeHooks(readJsonOr(target, {}), renderManifest(spec.src));
  if (dryRun) {
    out(`would write ${target}:`);
    out(JSON.stringify(merged, null, 2));
    return 0;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(merged, null, 2) + "\n");
  out(`installed spor for ${spec.label} → ${target}  (scope: ${scope})`);
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
    fs.copyFileSync(src, target);
    how = "copied";
  }
  out(`installed spor for ${spec.label} → ${target}  (${how}, scope: ${scope})`);
  if (how === "copied") out(`  note: copied (no symlink here) — export SPOR_ROOT=${ROOT} so the plugin finds its core.`);
  return 0;
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

  // The "configure" half: persist server/token to user config when given.
  const server = values.server;
  const token = values.token;
  if ((server || token) && !dryRun) {
    try {
      const f = writeServerToken(cfg.userConfigHome(), server, token);
      out(`wrote ${[server && "server", token && "token"].filter(Boolean).join(" + ")} to ${f}`);
    } catch (e) {
      err(`could not write config: ${e.message}`);
    }
  }

  if (!hosts.length) {
    // Discovery mode — show what is installable; touch nothing.
    const found = detectHosts();
    out("Usage: spor install <host>... [--scope user|repo] [--all] [--print]");
    out(`Hosts: ${Object.keys(HOSTS).join(", ")}`);
    out(found.length ? `Detected here: ${found.join(", ")}  (try: spor install ${found.join(" ")})` : "No host config dirs detected yet.");
    out("Claude Code: 'spor install claude' wires the plugin via its CLI — no marketplace browsing.");
    // The plugin runs on Node; its hooks fail open when Node is absent/too old,
    // so state the requirement up front (issue-spor-onboarding-no-node-silent-fail-open).
    out(`Requires: Node ${nodeFloor() || 20}+ on PATH — currently ${nodeChk.line.replace(/^node:\s*/, "")}`);
    return 0;
  }

  let rc = 0;
  for (const host of hosts) {
    const spec = HOSTS[host];
    let r;
    if (spec.kind === "claude") r = installClaude(scope, dryRun);
    else if (spec.kind === "plugin") r = installPluginHost(spec, scope, dryRun);
    else r = installHookHost(spec, scope, dryRun);
    if (r !== 0) rc = r;
  }

  if (!dryRun && hosts.some((h) => HOSTS[h].kind !== "claude")) {
    out("");
    out("next:");
    if (cfg.mode() === "remote") out(`  remote mode is configured (${remote.base(cfg)}).`);
    else out("  point at a graph:  spor join <token>   (hosted Spor; or 'spor join <url> <token>' / export SPOR_SERVER/SPOR_TOKEN)");
    out("  distiller backend (hosts without the claude CLI) + on-demand MCP access: see adapters/<host>/README.md");
    out("  approve the hooks on first run if the host prompts.");
  }
  return rc;
}

// --- spor upgrade: refresh wired spor to the installed package version -------
// (issue-spor-upgrade-no-plugin-refresh) An npm bump updates the package on disk
// but NOT what an agent already loaded: Claude Code runs its OWN cached copy of
// the plugin, so it keeps running stale skills/hooks until 'plugin update' swaps
// the copy. The hook hosts (codex/cursor/copilot/gemini/opencode) reference the
// package by absolute path, so they only go stale if the checkout MOVED — for
// which re-running the idempotent install refreshes the path. This verb does
// both in one step and tells the user to restart the session.

// Refresh Claude Code's loaded plugin (marketplace add to register/repoint the
// source, then the shared marketplace+plugin update). Returns 0/1.
function upgradeClaude(scope, dryRun) {
  const cmd = claudeCmd();
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
  const before = claudePluginInfo();
  if (!before) {
    err("spor isn't installed in Claude Code yet — run 'spor install claude' first.");
    return 1;
  }
  // Re-register the marketplace source first, tolerating "already exists", so a
  // moved checkout repoints before the update re-reads it.
  const add = spawnSync(cmd, mpAdd, { encoding: "utf8" });
  if (add.status !== 0 && !/already|exists|known/i.test((add.stderr || "") + (add.stdout || ""))) {
    err(`claude plugin marketplace add failed: ${(add.stderr || add.stdout || "").trim() || "unknown error"}`);
    return 1;
  }
  return refreshClaudePlugin(cmd, cliScope, before);
}

// Is spor actually wired into this host on this machine (vs the host merely being
// present)? claude: ask its plugin list; hook/plugin hosts: look for the spor
// marker in the target config. Picks which hosts 'spor upgrade' (no host) touches.
function hostHasSpor(host, scope) {
  if (host === "claude") return !!claudePluginInfo();
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
  if (!hosts.length) hosts = detectHosts().filter((h) => hostHasSpor(h, scope));
  if (!hosts.length) {
    out("nothing to upgrade — spor isn't wired into any detected host. Run 'spor install <host>'.");
    return 0;
  }
  out(`package: @sporhq/spor ${version()} (this CLI)`);
  let rc = 0;
  for (const host of hosts) {
    let r;
    if (host === "claude") r = upgradeClaude(scope, dryRun);
    else {
      // Re-running install refreshes the absolute __SPOR_ROOT__ path (a no-op
      // when the path is unchanged; repairs a moved checkout when it is not).
      const spec = HOSTS[host];
      r = spec.kind === "plugin" ? installPluginHost(spec, scope, dryRun) : installHookHost(spec, scope, dryRun);
    }
    if (r !== 0) rc = r;
  }
  if (!dryRun) {
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

// --- spor dispatch: kick off a Claude Code background agent --------------
// (task-spor-cli-dispatch-background-agents) Compile a briefing for a task and
// launch `claude --bg "<prompt>"` in the correct repo. The "correct repo" comes
// from a per-machine slug->path map stored in the config cascade under
// `dispatch.repos` (read via cfg.get; written to $SPOR_HOME/config.json) — the
// shared graph is path-free by design (repo nodes carry slugs/fingerprints,
// never a local path; teammates clone to different paths), so the map MUST be
// local. It self-learns from session-start and from `--dir`/`spor repos`.

// Read a single frontmatter scalar from raw node markdown (regex, like the
// engines' parser — no YAML lib). `repo:` is the current stamp; `project:` legacy.
function fmField(raw, key) {
  const m = raw.match(new RegExp(`^${key}: *(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

// Resolve a node id to { id, raw, repo, title } or null if it doesn't exist.
async function resolveNode(cfg, id) {
  let raw = "";
  // The server's get(node) hook attaches read-time enrichment as additive
  // top-level keys (API.md §3): `resolution` is the live inbound resolves/answers
  // edge (the resolver's id/summary/title), present only when the node is retired
  // by one. Keep it so the resolved-task guard can refuse without a second fetch.
  let resolution = null;
  if (cfg.mode() === "remote") {
    const r = await remote.get(cfg, `/v1/nodes/${encodeURIComponent(id)}`, { timeoutMs: 6000 });
    if (!r.ok) return null;
    raw = (r.json && r.json.raw) || r.text || "";
    resolution = (r.json && r.json.resolution) || null;
  } else {
    try {
      raw = fs.readFileSync(path.join(cfg.nodesDir(), `${id}.md`), "utf8");
    } catch {
      return null;
    }
  }
  return { id, raw, repo: fmField(raw, "repo") || fmField(raw, "project"), title: fmField(raw, "title") || "", resolution };
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
function dispatchResolutionReason(cfg, node) {
  const status = (fmField(node.raw, "status") || "").toLowerCase();
  if (isTerminalStatus(status)) return `status: ${status}`;
  const fromEdge = (r) => `${r.edge || "resolves"} edge from ${r.by}${r.title ? ` — ${r.title}` : ""}`;
  if (node.resolution && node.resolution.by) return fromEdge(node.resolution);
  if (cfg.mode() !== "remote") {
    try {
      const g = require(path.join(ROOT, "lib", "graph.js")).loadGraph(cfg.nodesDir());
      const r = resolutionOf(g, node.id);
      if (r && r.by) return fromEdge(r);
    } catch {
      /* fail-open — an unreadable graph never blocks a dispatch */
    }
  }
  return null;
}

// Resolve the profile THIS dispatch would run UNDER and check whether this
// machine can satisfy it (dec-spor-machine-profile-satisfiability, FORK B).
// Precedence (cascade, explicit wins): --profile flag > the dispatched node's
// assigned->agent edge `profile:` attribute > that agent's default uses-profile.
// Returns null when NO profile resolves (no assignment, no profile nodes yet) —
// the common case, leaving dispatch byte-identical. Otherwise
// { id, source, found, verdict }: an explicitly-named --profile that can't be
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
    probed = u.probeCapabilities(cfg.userConfigHome(), { sporReachable: cfg.mode() === "remote" });
  } catch {
    /* probe is best-effort; match against what the cascade already holds */
  }
  const machine = sat.effectiveCapabilities(probed ? { ...rawCap, probed } : rawCap);
  return { id, source, found: true, verdict: sat.satisfies(machine, profile) };
}

// Compile a briefing: a node id -> its neighborhood; free text -> a digest.
// Mode-aware, reusing the primitives the /spor:brief skill drives. Default is
// the compact digest; `full` emits the whole neighborhood. "" = graph had
// nothing relevant (or the compile failed — fail-soft, dispatch still proceeds).
async function compileBriefing(cfg, { nodeId, query, full, project }) {
  if (cfg.mode() === "remote") {
    if (nodeId) {
      // Same raw-node + seeded-neighborhood resolution as `spor brief <id>`, so
      // a dispatched agent's standing context matches an interactive brief
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

// The highest-ranked open queue item for --from-queue — the first that ISN'T
// already in flight on THIS machine. Mode-aware, fail-soft (null on any
// error/empty). This used to take limit=1 blindly, but the queue's lease filter
// is viewer-relative (lib/kernel/queue.js): a lease held by ANOTHER person is
// dropped, yet the dispatcher's OWN in-progress claim is kept and floated up by
// its `front` signal — so the top item was frequently the caller's own active
// work, which the same-machine guard then refused instead of advancing
// (task-spor-dispatch-from-queue-skip-in-flight). So pull a page and skip items
// with a background agent already running here — dispatchedAgents()/
// annotateInFlight, the same NO-LLM, fail-soft cross-reference the same-machine
// guard and `spor next --hide-dispatched` use — returning the first not-in-flight
// item. If EVERY candidate is in flight, fall back to the top one so the caller's
// guard reports it (rather than a misleading "queue empty"). A page (not just the
// top) is fetched in BOTH modes; with no agents in flight free[0] is still the
// top item, so the prior single-pick behavior is preserved.
async function topQueueItem(cfg, slug) {
  const LIMIT = 25;
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
    items = r.ok && r.json ? r.json.items || [] : [];
  } else {
    try {
      const g = require(path.join(ROOT, "lib", "graph.js")).loadGraph(cfg.nodesDir());
      const { rankQueue } = require(path.join(ROOT, "lib", "queue.js"));
      const opts = { limit: LIMIT, excludeTypes: ["question"] };
      const r = rankQueue(g, slug ? { project: slug, ...opts } : opts);
      items = r.items || [];
    } catch {
      items = [];
    }
  }
  if (!items.length) return null;
  // Defense-in-depth: drop any question the ranker left in (an older server that
  // predates / ignores exclude_type), so a question is never dispatched even
  // against a stale backend. Primary exclusion is at the ranker above.
  items = items.filter((it) => it.type !== "question");
  if (!items.length) return null;
  // Defense-in-depth (dec-spor-queue-hide-blocked): a current ranker drops
  // blocked items from the page entirely, but a stale server may still return
  // them demoted (suggest:blocked / blocked_by set). --from-queue dispatches an
  // AGENT to do work, and a blocked item can't proceed until its unblocker
  // lands — never dispatch one, even against an old backend. Mirrors the
  // question defense above.
  items = items.filter((it) => it.suggest !== "blocked" && !(Array.isArray(it.blocked_by) && it.blocked_by.length));
  if (!items.length) return null;
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
  if (!items.length) return null;
  // Skip items already in flight on this machine; advance to the first free one.
  const { items: free, hidden } = annotateInFlight(items, dispatchedAgents(), true);
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
function createDispatchWorktree(repoDir, name, { setup, slug, nodeId } = {}) {
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
  if (setup) {
    const sr = spawnSync(setup, [], {
      cwd: dir,
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        SPOR_WORKTREE: dir,
        SPOR_MAIN_CHECKOUT: repoDir,
        SPOR_DISPATCH_SLUG: slug || "",
        SPOR_DISPATCH_NODE: nodeId || "",
      },
    });
    if (sr.error) return { dir, branch, reused, created: !reused, setupError: sr.error.message };
    if (sr.status !== 0) return { dir, branch, reused, created: !reused, setupError: `setup hook exited ${sr.status}` };
    return { dir, branch, reused, setupRan: true };
  }
  return { dir, branch, reused, setupRan: false };
}

// Best-effort teardown of a worktree WE just created (setup-hook failure path):
// never strand a half-prepped worktree + branch. A reused worktree is left
// untouched (it predates this dispatch).
function removeDispatchWorktree(repoDir, dir, branch) {
  git(repoDir, ["worktree", "remove", "--force", dir]);
  if (branch) git(repoDir, ["branch", "-D", branch]);
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
// identity rides the token in --mcp-config, never env). These three helpers are
// the verified mechanism; all fail soft so a server without the agent surface,
// or a machine with no agent configured, degrades to the prior person-scoped
// dispatch with a clear line.

// This machine's agent node id, or null. A per-machine config key the shared
// graph can't hold (like dispatch.repos) — SPOR_DISPATCH_AGENT / .spor.json
// {"dispatch":{"agent":"agent-x"}} / user config. null => dispatch without
// agent-scoping (graceful, person-attributed as before).
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
// { ok, token } on success, { absent:true }
// when the mint surface isn't deployed yet (404 — fail soft, dispatch person-
// scoped), or { error } on any other failure incl. 403/owner-mismatch (also fail
// soft — warn and dispatch person-scoped, never block).
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

async function cmdDispatch(cfg, { values, positionals: pos }) {
  const dryRun = !!(values.print || values["dry-run"]);
  const full = !!values.full;
  const noBrief = !!values["no-brief"];
  const noClaim = !!values["no-claim"];
  const force = !!values.force;
  const backfill = !!values.backfill;
  const fromQueue = !!values["from-queue"];
  const dirOpt = values.dir || null;
  const model = values.model || null;
  const permMode = values["permission-mode"] || null;
  const agent = values.agent || null; // claude --agent (harness agent DEFINITION)
  const asAgent = values.as || null; // Spor agent IDENTITY override for dispatch.agent
  // A user-supplied prompt template (task-spor-dispatch-user-prompt-templates):
  // --template wins, else a personal default in the config cascade
  // (dispatch.template — an absolute path, like dispatch.repos). Empty until we
  // resolve the file below, so an absent option leaves the prompt byte-identical.
  const templateOpt = values.template || cfg.get("dispatch.template", null);
  let nodeId = values.node || null;
  let targetSlug = values.slug || null;
  let name = values.name || null;
  const profileFlag = values.profile || null;
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
  let resolvedReason = null; // set in node mode when the target is already resolved

  if (fromQueue) {
    const top = await topQueueItem(cfg, targetSlug);
    if (!top || !top.id) {
      err("queue empty — nothing to dispatch");
      return 1;
    }
    nodeId = top.id;
    targetSlug = targetSlug || top.repo || top.project || null;
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
    resolvedReason = dispatchResolutionReason(cfg, node);
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
  // FROM (the cfg cascade only sees the dispatcher's cwd). Forced off for
  // --backfill, which sets up the MAIN checkout itself. The setup hook follows
  // the same target-first precedence; relative paths in the marker resolve
  // against the repo (the spor-server hook stages the node_modules symlink +
  // $SPOR_LIB the bare worktree needs).
  const targetCfg = targetRepoDispatchCfg(res.dir);
  const worktreeSetup =
    targetCfg.worktreeSetup != null ? targetCfg.worktreeSetup : cfg.get("dispatch.worktreeSetup", null);
  const worktreeDefault =
    targetCfg.worktree != null ? targetCfg.worktree : !!cfg.get("dispatch.worktree", false);
  const useWorktree =
    !backfill && (values["no-worktree"] ? false : !!(values.worktree || worktreeDefault));

  // Session project (issue-spor-dispatch-propagate-session-project-to-questions).
  // The launcher env never reaches a `claude --bg` agent (it self-allocates a
  // spare worker; dec-spor-session-identity-active-record), and the agent token
  // carries only {agent, session} — NOT the project. So the only channel the
  // session project can ride to the bg agent is the prompt itself: state it, and
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
      node: nodeId || "", node_id: nodeId || "",
      title: nodeTitle,
      slug: res.slug || "", project: res.slug || "", repo: res.slug || "",
      dir: res.dir || "",
      default: defaultPrompt,
    });
    if (r.unknown.length) {
      err(
        `warning: unknown template placeholder(s): ${[...new Set(r.unknown)].join(", ")} ` +
          `(available: brief, task, node, title, slug, dir, default)`
      );
    }
    prompt = r.text;
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
  const inFlight = nodeId && !backfill ? dispatchedAgents().get(name) || [] : [];

  // Session identity (dec-spor-dispatch-bg-session-late-bind). `claude --bg`
  // IGNORES `--session-id` and self-allocates its own run session (verified — it
  // warns and ignores the flag), so we do NOT force one and the session is NOT
  // knowable up front. The agent token is minted session-DEFERRED; the real
  // session is captured from `claude agents --json` AFTER launch and bound then
  // (rebind the token + renew the lease). SPOR_SESSION_ID pins the session for
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
  // token-mint and silently fall back to person-scoped on EVERY dispatch, quietly
  // defeating agent attribution (issue-spor-dispatch-agent-id-prefix-validation-gap).
  // Catch it here with an actionable line and run person-scoped, rather than a
  // round-trip to a 422 that names nothing. Fail-soft (don't block the dispatch):
  // the explicit --as path already hard-errored above, so this only fires for the
  // config default.
  if (identityAgent && !isAgentId(identityAgent)) {
    err(`warning: configured dispatch.agent '${identityAgent}' is not a valid agent id — dispatching person-scoped.`);
    const guess = agentIdGuess(identityAgent);
    err(`  agent ids start with 'agent-'.${guess ? ` fix: spor agent use ${guess}` : ""}  ('spor agent list' shows your agents.)`);
    identityAgent = null;
  }
  // An explicit --as can't take effect in local mode — there is no CA to mint the
  // agent token. Say so rather than silently dropping it to person-scoped.
  if (asAgent && cfg.mode() !== "remote") {
    err(`note: --as ${asAgent} ignored in local mode — agent-on-behalf-of attribution is remote-only`);
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

  const claudeBin = claudeCmd();
  const claudeArgs = ["--bg"];
  if (name) claudeArgs.push("--name", name);
  if (model) claudeArgs.push("--model", model);
  if (permMode) claudeArgs.push("--permission-mode", permMode);
  if (agent) claudeArgs.push("--agent", agent);
  // NB: no `--session-id` — `claude --bg` ignores it (warns) and manages its own
  // session; we capture the real one post-launch (dec-spor-dispatch-bg-session-late-bind).

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
    out(`session: ${pinnedSession || "(allocated by claude --bg at launch, bound after)"}`);
    // Identity preview: what the real dispatch would do for agent-scoping. The
    // token mint + 0600 mcp-config are SIDE EFFECTS, so --print only describes
    // them (it writes nothing and makes no network call here). Local mode and an
    // unconfigured machine read "person-scoped" — byte-stable but for the new
    // session line, which is additive and always present now.
    if (identityAgent) {
      const src = asAgent ? " (via --as)" : "";
      out(`agent:  ${identityAgent}${src} (would mint a session-deferred agent-scoped token + write a 0600 --mcp-config, add --strict-mcp-config, then bind the run session after launch)`);
    } else if (cfg.mode() === "remote") {
      out(`agent:  (none configured — 'spor agent use agent-<machine>' or --as to attribute as agent-on-behalf-of; dispatching person-scoped)`);
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
    out(`run:    ${claudeBin} ${claudeArgs.map(shellQuote).join(" ")} <prompt>`);
    out(`\n--- prompt ---\n${prompt}`);
    return 0;
  }

  // Refuse an already-RESOLVED target before the lease/claim, repo registration,
  // worktree, and agent launch — and before the profile host-match call below
  // (issue-spor-dispatch-resolved-task-no-guard): dispatching an agent at a node
  // that is already done — a terminal status, or retired by a live inbound
  // resolves/answers edge — would just redo finished work and write another
  // outcome onto a closed node. (The briefing compile above already ran, exactly
  // as it does for the sibling in-flight guard — refusal is post-briefing,
  // pre-launch.) Mirrors the in-flight same-machine guard (node mode, both modes);
  // --force overrides, like that guard and the remote-only duplicate-claim guard.
  // The ranker already drops resolved items from --from-queue (dec-spor-dispatch-
  // duplicate-dedup-at-capture-source), so for an auto-pick this is defense-in-depth;
  // for an explicit `--node <id>` it is the primary guard. Checked first among the
  // real-run guards so a resolved node short-circuits the host-match call and launch.
  if (resolvedReason && !force) {
    err(`${nodeId} is already resolved (${resolvedReason}) — not dispatching.`);
    err(`  re-run with --force to dispatch at it anyway, or pick another task with 'spor next'.`);
    return 1;
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

  if (claudeBin === "claude" && !hasCmd("claude")) {
    err("claude CLI not on PATH — install Claude Code, then re-run (or 'spor dispatch … --print' to see the prompt).");
    return 1;
  }

  // Agent-scoped identity injection (dec-spor-session-identity-active-record,
  // the VERIFIED mechanism): mint a per-session agent-scoped token, write it into
  // a 0600 --mcp-config that exposes ONLY the agent's own Spor MCP, and add
  // --strict-mcp-config so the account connector is excluded by construction. The
  // server then stamps authored_by_agent + session from that token. The token is
  // minted session-DEFERRED — the run session isn't known until `claude --bg`
  // self-allocates it, so we bind it AFTER launch (dec-spor-dispatch-bg-session-
  // late-bind), keeping `agentToken` to authenticate that late bind. FAIL SOFT at
  // every step — a server without the mint surface, or a transient error, falls
  // back to the prior person-scoped dispatch with a clear line. Remote + a
  // configured agent only; local/unconfigured dispatch is byte-identical.
  let agentToken = null;
  if (identityAgent) {
    // Always session-DEFERRED — the run session is bound after launch (below),
    // even when SPOR_SESSION_ID pins it (the pin feeds the capture, not the mint),
    // so the bind path is uniform.
    const mint = await mintAgentToken(cfg, { agent: identityAgent });
    if (mint.ok) {
      agentToken = mint.token;
      const mcpFile = writeDispatchMcpConfig(cfg, { token: mint.token, key: mcpKey });
      claudeArgs.push("--mcp-config", mcpFile, "--strict-mcp-config");
      out(`agent:  ${identityAgent} (writes attributed agent-on-behalf-of-you; run session bound after launch)`);
    } else if (mint.absent) {
      err(`warning: this server can't mint agent-scoped session tokens yet — dispatching person-scoped.`);
    } else {
      // Name the offending agent and the fix — a bare "(HTTP 422 …)" tells the
      // operator nothing about WHICH id is wrong or how to repair it. The format
      // gate is now caught client-side above, so a 422 here means the id is a
      // well-formed 'agent-<slug>' the server still rejected (e.g. no such agent /
      // not owned); point at the list either way
      // (issue-spor-dispatch-agent-id-prefix-validation-gap).
      err(`warning: could not mint an agent token for ${identityAgent} (${mint.error}) — dispatching person-scoped.`);
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
  // isn't known until after launch, so we bind it to the lease via renewDispatch
  // below; until then any of this person's sessions may renew it.
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
    if (c.ok) out(`claimed ${nodeId} (lease established; the agent's writes will renew it)`);
    else err(`warning: could not establish a lease on ${nodeId}: ${c.error} — dispatching without a claim`);
  }
  // Materialize the worktree just before launch — AFTER every guard/claim, so a
  // refused dispatch never leaves a worktree behind — and run the agent inside it.
  // res.dir stays the registered slug->path target (the durable main checkout,
  // issue-spor-dispatch-worktree-dir-stamping); only the launch cwd moves.
  let launchDir = res.dir;
  if (useWorktree) {
    const wt = createDispatchWorktree(res.dir, name, { setup: worktreeSetup, slug: res.slug, nodeId });
    if (wt.error) {
      err(`could not create dispatch worktree under ${res.dir}: ${wt.error}`);
      err(`  (is ${res.dir} a git repo with at least one commit? or pass --no-worktree.)`);
      return 1;
    }
    if (wt.setupError) {
      err(`dispatch worktree setup hook failed: ${wt.setupError}`);
      if (wt.created) {
        removeDispatchWorktree(res.dir, wt.dir, wt.branch);
        err(`  removed the half-prepped worktree ${wt.dir}. Fix dispatch.worktreeSetup or pass --no-worktree.`);
      } else {
        err(`  left the reused worktree ${wt.dir} in place. Fix dispatch.worktreeSetup or pass --no-worktree.`);
      }
      return 1;
    }
    launchDir = wt.dir;
    out(`worktree: ${wt.dir} (branch ${wt.branch}${wt.reused ? ", reused" : ""}${wt.setupRan ? "; setup ran" : ""})`);
  }

  claudeArgs.push(prompt);
  const r = spawnSync(claudeBin, claudeArgs, { cwd: launchDir, stdio: "inherit" });
  if (r.error) {
    err(`could not launch ${claudeBin}: ${r.error.message}`);
    return 1;
  }

  // Late session binding (dec-spor-dispatch-bg-session-late-bind). `claude --bg`
  // has now self-allocated its run session and registered the agent; read the
  // REAL session from `claude agents --json` and bind it: (a) rebind the agent
  // token's session so every subsequent agent write stamps the real run, and
  // (b) renew the lease to it so lease and token agree (instead of waiting for
  // the agent's first heartbeat to self-heal). Best-effort throughout — a capture
  // miss or any bind failure leaves the token session-null (writes carry no
  // session: honest, never a phantom) and the lease self-healing via heartbeat.
  // Remote only, and only when there's something to bind (an agent token and/or a
  // claimed node).
  const wantBind = cfg.mode() === "remote" && (agentToken || (nodeId && !backfill && !noClaim));
  if (wantBind) {
    const realSession = await captureDispatchSession(name, launchDir, pinnedSession);
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
    const probed = u.probeCapabilities(home, { sporReachable: !!cfg.server() });
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
    probed = u.probeCapabilities(cfg.userConfigHome(), { sporReachable: true });
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
  if (res.published_by) out(`  published_by:  ${res.published_by}`);
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
      const meta = [h.owner, `${relAge(h.age_seconds)} ago`].filter(Boolean).join(", ");
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
      const meta = [h.owner, `${relAge(h.age_seconds)} ago`].filter(Boolean).join(", ");
      out(`  ✓ ${h.agent}${meta ? ` (${meta})` : ""}`);
    }
  } else {
    out("satisfiable: (none — escalate to the owner; never substitute a different profile)");
  }
  if (no.length) {
    out("unsatisfiable:");
    for (const h of no) {
      const meta = [h.owner, `${relAge(h.age_seconds)} ago`].filter(Boolean).join(", ");
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
      "--server/--token also persist remote-graph credentials to your user config.",
    options: {
      scope: SCOPE_OPT,
      all: { type: "boolean", desc: "install into every detected host" },
      print: PRINT_OPT,
      "dry-run": DRYRUN_OPT,
      server: { type: "string", value: "url", desc: "persist a team-graph server URL to user config" },
      token: { type: "string", value: "tok", desc: "persist an auth token to user config" },
    },
    examples: ["spor install claude", "spor install codex gemini --scope repo", "spor install --all --print"],
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
    group: "Getting started", parse: "strict", args: "", options: {},
    summary: "resolved mode, graph, project, identity, health",
    help: "Print the resolved mode (local/remote), graph home, project slug, identity,\nand a health probe. In local mode it also warns of a split-brain claude.ai\nSpor MCP connector; it always surfaces the Node prerequisite line.",
    run: (cfg) => cmdStatus(cfg),
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
      "      --id person-x             explicit node id (default person-<kebab(name)>)\n" +
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
    group: "Dispatch (Claude Code background agents)", parse: "raw", args: "create <label> [--owner <id>] [--pubkey <fp>] | list | use <agent-id> | token <agent-id> [list|revoke <prefix>]",
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
      "                                --clear to go back to person-scoped dispatch)\n" +
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
      "the work) and it surfaces in their queue, ramping urgency as the date nears.",
    options: {
      type: { type: "string", value: "T", desc: "node type (local only; default: task)" },
      title: { type: "string", value: "...", desc: "title (default: first 10 words)" },
      project: { type: "string", value: "S", desc: "project slug (default: inferred from cwd; the SERVING project for a cross-project dependency)" },
      id: { type: "string", value: "id", desc: "explicit node id (local only)" },
      during: { type: "string", value: "id", desc: "node this was discovered during (derived-from edge)" },
      blocks: { type: "string", value: "id", desc: "node id this work blocks (cross-project dependency; target must exist)" },
      "needed-by": { type: "string", value: "date", desc: "YYYY-MM-DD deadline that ramps queue urgency (pairs with --blocks)" },
    },
    examples: [
      'spor add "Cache tf-idf norms across compiles for speed" --type task',
      'spor add "Platform must expose a token-rotation hook" --project platform --blocks task-my-initiative --needed-by 2026-07-15',
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
    group: "Graph", parse: "raw", args: "[<type>] [--edges] [--json]",
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
      "  --nodes <dir>     read this local graph dir instead of the resolved home",
    examples: [
      "spor schema",
      "spor schema task",
      "spor schema --edges --json",
      "spor schema --source graph",
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
    group: "Repo scoping", parse: "strict", args: "", options: {},
    summary: "opt this repo in (.spor.json)",
    help: "Set { enabled: true } in this repo's committable .spor.json. Spor is opt-in\nper repo — a repo with no .spor/.spor.json marker is a no-op — so this is how\nyou turn it on (and how you undo a prior 'spor disable'). Commit the file to\nshare the setting.",
    run: (cfg) => cmdScope(true),
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
    group: "Dispatch (Claude Code background agents)", parse: "strict", args: '"<task>" | <node-id>', aliases: ["bg"],
    summary: "compile a briefing + launch 'claude --bg' in the repo",
    help:
      "Compile a briefing for a task and launch a Claude Code background agent in the\n" +
      "right repo. Give free-text, a <node-id>, --node <id>, --from-queue (the top\n" +
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
      "--worktree runs the agent in its own git worktree off the repo (branch = the\n" +
      "node id / sanitized task), so parallel dispatches never race the shared tree/\n" +
      "index. Make it a repo default with dispatch.worktree — in the TARGET repo's\n" +
      "committable .spor.json (honored wherever it's dispatched from) or your\n" +
      "machine-local config. dispatch.worktreeSetup names a hook (script path or\n" +
      "command; relative paths resolve against the repo) that preps each worktree —\n" +
      "it runs with cwd=worktree and SPOR_WORKTREE/SPOR_MAIN_CHECKOUT/\n" +
      "SPOR_DISPATCH_SLUG|NODE in the env (e.g. symlink node_modules, write\n" +
      ".claude/settings.local.json env). --no-worktree opts a single run out.\n\n" +
      "--template supplies your own prompt with {{brief}}/{{task}}/{{node}}/{{title}}/\n" +
      "{{slug}}/{{dir}}/{{default}} placeholders.\n\n" +
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
      model: { type: "string", value: "M", desc: "claude --model" },
      "permission-mode": { type: "string", value: "P", desc: "claude --permission-mode" },
      agent: { type: "string", value: "A", desc: "claude --agent (harness agent DEFINITION — NOT the Spor identity; see --as)" },
      profile: { type: "string", value: "profile-id", desc: "profile to run under; checked against this machine's capabilities (overrides the assigned/default profile)" },
      name: { type: "string", value: "N", desc: "claude --name (session name)" },
      template: { type: "string", value: "F", desc: "prompt template file (placeholders above)" },
      full: { type: "boolean", desc: "full briefing instead of the digest" },
      "no-brief": { type: "boolean", desc: "raw task prompt, no briefing block" },
      "no-claim": { type: "boolean", desc: "don't auto-claim the lease (remote node dispatch)" },
      force: { type: "boolean", desc: "dispatch even if the node is already resolved, or an agent for it is in flight here" },
      "from-queue": { type: "boolean", desc: "dispatch the top-ranked queue item not already in flight here" },
      backfill: { type: "boolean", desc: "init + enable + launch /spor:backfill (the primitive behind /spor:onboard)" },
      worktree: { type: "boolean", desc: "run the agent in its own git worktree (overrides dispatch.worktree)" },
      "no-worktree": { type: "boolean", desc: "force-disable worktree isolation for this dispatch" },
      print: { type: "boolean", desc: "dry run — print the prompt, launch nothing" },
      "dry-run": DRYRUN_OPT,
    },
    examples: ['spor dispatch "rotate the pipeline auth tokens" --dir ../api', "spor dispatch dec-x --model haiku", "spor dispatch --from-queue --print"],
    run: (cfg, p) => cmdDispatch(cfg, p),
  },
  repos: {
    group: "Dispatch (Claude Code background agents)", parse: "raw",
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
    group: "Dispatch (Claude Code background agents)", parse: "raw", aliases: ["caps", "profiles"],
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
  "Dispatch (Claude Code background agents)",
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
module.exports = { nodeFloor, nodeRuntimeCheck, verCmp, sporConnectorBound, COMMANDS, resolveVerb, getNodeJson, gitBlobSha };

if (require.main === module) {
  main()
    .then((code) => process.exit(code || 0))
    .catch((e) => {
      err(`spor: ${e && e.message ? e.message : String(e)}`);
      process.exit(1);
    });
}
