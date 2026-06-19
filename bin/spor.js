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
const { loadConfig } = require(path.join(ROOT, "lib", "config.js"));
const remote = require(path.join(ROOT, "lib", "remote.js"));
const u = require(path.join(ROOT, "scripts", "engines", "util.js"));
const sat = require(path.join(ROOT, "lib", "kernel", "satisfiability.js"));

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

// Idempotently create the local graph home (nodes/, git, .gitignore). Returns
// { home, nodesDir, created } and prints nothing — callers do their own UX.
// Shared by `spor init` and the `spor dispatch --backfill` onboarding path.
function ensureGraphHome(cfg) {
  const home = cfg.graphHome();
  const nodesDir = path.join(home, "nodes");
  let created = false;
  if (!fs.existsSync(nodesDir)) {
    fs.mkdirSync(nodesDir, { recursive: true });
    created = true;
  }
  // git init (idempotent) so the graph is versioned, like README's bootstrap.
  if (!fs.existsSync(path.join(home, ".git"))) {
    const r = spawnSync("git", ["init", "-q"], { cwd: home, stdio: "ignore" });
    if (r.error) err("note: git not found — graph created but not version-controlled");
  }
  const gitignore = path.join(home, ".gitignore");
  if (!fs.existsSync(gitignore)) {
    try {
      fs.writeFileSync(gitignore, "journal/\n");
    } catch {
      /* non-fatal */
    }
  }
  return { home, nodesDir, created };
}

function cmdInit(cfg) {
  const { home, nodesDir, created } = ensureGraphHome(cfg);
  out(`${created ? "Created" : "Graph already present at"} ${home}`);
  out(`  nodes:  ${nodesDir} (${nodeCount(nodesDir) ?? 0} nodes)`);
  out(`  mode:   ${cfg.mode()}`);
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
  out(`mode:     ${mode}${cfg.enabled() ? "" : "  (not enabled here — run 'spor enable' to opt in; hooks are a no-op)"}`);
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
    qs.set("limit", "10");
    if (inclTypes.length) qs.set("type", inclTypes.join(","));
    if (exclTypes.length) qs.set("exclude_type", exclTypes.join(","));
    const r = await remote.get(cfg, `/v1/queue?${qs.toString()}`, { timeoutMs: 6000 });
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
  // Never-silent truncation (task-spor-cli-in-flight-surface): report what
  // --hide-dispatched removed, the way queue.js surfaces the muted count.
  if (hidden > 0) out(`(${hidden} in-flight hidden — --hide-dispatched)`);
}

async function cmdGet(cfg, { positionals }) {
  const id = positionals[0];
  if (!id) {
    err("usage: spor get <id>");
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
    out(r.json && r.json.raw ? r.json.raw : r.text);
    return 0;
  }
  // local: read the node file
  const f = path.join(cfg.nodesDir(), `${id}.md`);
  try {
    out(fs.readFileSync(f, "utf8"));
    return 0;
  } catch {
    err(`no such node: ${id}`);
    return 1;
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

// query enumerates a LOCAL graph (lib/query.js) — the structured node/edge
// list that `get`/`next`/`compile --query` are not (task-spor-local-graph-query-
// verb). It is the local-mode primitive under remote mode's saved render_lens
// views, so like validate it is local-only: in remote mode there is no local
// loadGraph, so fail fast naming that unless --nodes points at a local checkout.
function cmdQuery(cfg, args) {
  if (cfg.mode() === "remote" && !namesLocalGraph(args)) {
    err("query enumerates a LOCAL graph; in remote mode the server holds the graph,");
    err("  so use a saved view instead (spor lens). Point --nodes at a local checkout");
    err("  to query it, or unset SPOR_SERVER to query the local graph home.");
    return 1;
  }
  return passthrough("query.js", args);
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

async function cmdAdd(cfg, { values, positionals }) {
  const prose = positionals[0];
  if (!prose) {
    err('usage: spor add "<text>" [--type T] [--title ...] [--project S]');
    return 1;
  }
  const project = values.project || safeSlug();

  if (cfg.mode() === "remote") {
    const r = await remote.post(cfg, "/v1/capture", { text: prose, context: { project } });
    if (r.transport) {
      err(`offline — capture not shipped (${r.error}). It will be retried by the hooks' outbox in a normal session.`);
      return 1;
    }
    if (!r.ok) {
      err(`capture error ${r.status}`);
      return 1;
    }
    const ids = (r.json && (r.json.ids || r.json.node_ids)) || [];
    out(ids.length ? `captured: ${ids.join(", ")}` : `captured (${(r.json && r.json.status) || "ok"})`);
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

  const md = `---\nid: ${id}\ntype: ${type}\nrepo: ${project}\ntitle: ${title.replace(/\n/g, " ")}\nsummary: ${summary.replace(/\n/g, " ")}\ndate: ${today()}\n---\n\n${prose}\n`;
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

// --- spor join / login --------------------------------------------------
// Write server+token to USER config (never a committable repo config), then
// confirm immediately — the upgrade research found no one-step way to point a
// client at a graph and know it took.
async function cmdJoin(cfg, { values, positionals }) {
  const server = values.server || positionals[0];
  const token = values.token || positionals[1];
  if (!server) {
    err("usage: spor join <server-url> <token>");
    return 1;
  }
  let cfgFile;
  try {
    cfgFile = writeServerToken(cfg.userConfigHome(), server, token);
  } catch (e) {
    err(`could not write config: ${e.message}`);
    return 1;
  }
  out(`wrote server${token ? " + token" : ""} to ${cfgFile}`);
  if (!token) out(`note: no token given — set SPOR_TOKEN or 'spor join <server> <token>' to authenticate`);
  // confirm against the freshly-written config
  const fresh = loadConfig({ cwd: process.cwd() });
  return await cmdStatus(fresh);
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
  out(`  revoke later with: spor token revoke ${j.hash_prefix}`);
  return 0;
}

// --- spor agent: a person-owned automation principal ----------------------
// dec-spor-agent-identity-nodes: an agent is a first-class `type: agent` node
// owned by a person via an `owned-by` edge, so a dispatched session's writes
// read "agent on behalf of person" instead of person-direct. One persistent
// node per machine/install, created once here and reused across dispatches.
//
// REMOTE: POST /v1/admin/agents creates the node + owned-by edge through the
//   server's validated Store door, admin-gated like /v1/admin/people (the
//   server is the CA, it mints the spiffe). FAIL-SOFT on 404 — the endpoint is
//   landing in the spor-server stream; an old server gets a clear message, not
//   a crash.
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
  err("usage: spor agent create <label> [--owner person-x] [--pubkey <fp>] | spor agent list | spor agent use <agent-id>");
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

async function cmdAgentCreateRemote(cfg, { label, owner, pubkey }) {
  const body = { label };
  if (owner) body.owner = owner;
  if (pubkey) body.pubkey = pubkey;
  const r = await remote.post(cfg, "/v1/admin/agents", body);
  if (r.transport) {
    err(`offline — could not reach server (${r.error})`);
    return 1;
  }
  if (notAdminHint(r)) return 1;
  if (r.status === 404) {
    // The endpoint is part of the agent-identity rollout (the spor-server
    // stream); an older server doesn't have it yet. Fail soft, don't crash.
    err("this server has no agent-creation endpoint yet (POST /v1/admin/agents).");
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
  out(`created agent ${j.id || `agent-${kebab(label)}`}${j.owner ? ` owned by ${j.owner}` : ""}`);
  if (j.spiffe) out(`  spiffe: ${j.spiffe}`);
  out(`  make it this machine's default: spor agent use ${j.id || `agent-${kebab(label)}`}`);
  out(`  or dispatch as it once: spor dispatch --as ${j.id || `agent-${kebab(label)}`} …`);
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
        if (!c || c.type !== "agent" || c.change === "deleted") continue;
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

async function cmdToken(cfg, args) {
  if (cfg.mode() !== "remote") {
    err("token admin needs a team graph (remote mode).");
    return 1;
  }
  const sub = args[0];
  if (sub === "list") {
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
  if (sub === "revoke") {
    const prefix = args[1];
    if (!prefix) {
      err("usage: spor token revoke <hash-prefix>");
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
  err("usage: spor token list | spor token revoke <hash-prefix>");
  return 1;
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
    let c = git(home, ["commit", "-q", "-m", "spor: graph snapshot"]);
    // No git identity configured in this environment — fall back so the
    // housekeeping commit still lands. The user's own identity is preferred
    // whenever git has one; this only fires when it has none.
    if (c.status !== 0 && /identity|user\.(email|name)|empty ident/i.test(c.stderr || "")) {
      c = git(home, ["-c", "user.email=spor@localhost", "-c", "user.name=spor", "commit", "-q", "-m", "spor: graph snapshot"]);
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
    else out("  point at a graph:  spor join <server-url> <token>   (or export SPOR_SERVER/SPOR_TOKEN)");
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
  if (cfg.mode() === "remote") {
    const r = await remote.get(cfg, `/v1/nodes/${encodeURIComponent(id)}`, { timeoutMs: 6000 });
    if (!r.ok) return null;
    raw = (r.json && r.json.raw) || r.text || "";
  } else {
    try {
      raw = fs.readFileSync(path.join(cfg.nodesDir(), `${id}.md`), "utf8");
    } catch {
      return null;
    }
  }
  return { id, raw, repo: fmField(raw, "repo") || fmField(raw, "project"), title: fmField(raw, "title") || "" };
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
  const machine = sat.effectiveCapabilities(cfg.get("dispatch.capabilities", {}) || {});
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
    return p ? { dir: p, slug, source: "config" } : { dir: null, slug, source: "unknown" };
  }
  return { dir: dispatchRoot(), slug: safeSlug(), source: "cwd" };
}

// Quote an argv element for the --print display only (never used to spawn).
function shellQuote(s) {
  return /[^\w./:-]/.test(s) ? `'${String(s).replace(/'/g, "'\\''")}'` : s;
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

// `spor dispatch --backfill` is the onboarding door (task-spor-cli-dispatch-
// background-agents): set the repo up before launching its backfill agent.
// Idempotent; prints what it did. The dir-registration happens in cmdDispatch
// (it applies to every dispatch), this adds the init + enable steps.
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

  // Refuse BEFORE any side effect if this machine can't satisfy the resolved
  // profile (dec-spor-machine-profile-satisfiability, FORK B): fail soft and
  // loud, leave the task assigned and its lease/queue state untouched, NEVER
  // substitute a different profile. The human/routine chose THIS profile; a box
  // that can't honour it re-routes, it doesn't silently downgrade. No --force
  // bypass — that would be the silent substitution this rule forbids.
  if (unsatisfiable) {
    err(`cannot dispatch ${nodeId || name} here: this machine can't satisfy profile ${profileCheck.id} (via ${profileCheck.source}).`);
    for (const r of profileCheck.verdict.reasons) err(`  - ${r}`);
    err(`  the assignment is unchanged. Re-route to a machine that satisfies it, run 'spor capabilities' to`);
    err(`  declare/repair what's missing here, or pass a different --profile.`);
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
  claudeArgs.push(prompt);
  const r = spawnSync(claudeBin, claudeArgs, { cwd: res.dir, stdio: "inherit" });
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
    const realSession = await captureDispatchSession(name, res.dir, pinnedSession);
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

// --- spor repos: inspect/manage the local slug->path map -----------------
function cmdRepos(cfg, args) {
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
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
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
  err("usage: spor repos [list] | spor repos add <slug> <path> | spor repos rm <slug>");
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

  if (sub === "list" || sub === "show") return printList();

  // publish — PUSH this box's effective capabilities to the team server so the
  // remote fleet scheduler (task-spor-remote-fleet-scheduler) can host-match an
  // assigned profile against them: the remote twin of the LOCAL match `spor
  // dispatch` runs. Remote-only (a fleet needs a server); keyed on this
  // machine's dispatch.agent (the per-machine identity), so `spor agent use`
  // must have run first. Fail soft and loud, never block.
  if (sub === "publish") return cmdCapabilitiesPublish(cfg, { json });

  if (sub === "probe") {
    // Seed reachable_mcp:[spor] from CONFIGURED-ness when a Spor server/connector
    // is bound (remote mode) — the spor MCP is reachable by construction, no
    // network ping (task-spor-mcp-reachability-deterministic-seed).
    const probed = u.probeCapabilities(home, { sporReachable: !!cfg.get("server") });
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
    "usage: spor capabilities [list [--json]] | probe | publish | set <axis> <v...> | add <axis> <v...> | rm <axis> <v...>\n" +
      "       spor capabilities allow-mcp <name...> | deny <profile-id...> | undeny <profile-id...> | clear\n" +
      `       axes: ${AXES.join(", ")}`
  );
  return 1;
}

// cmdCapabilitiesPublish — push this box's EFFECTIVE capabilities to the team
// server's fleet scheduler (POST /v1/agents/{id}/capabilities,
// task-spor-remote-fleet-scheduler). The same effectiveCapabilities() collapse
// `spor capabilities` and `spor dispatch` read locally is what we publish, so
// the server's host-match agrees with the local one byte-for-byte. Remote-only,
// keyed on this machine's dispatch.agent. Fail soft and loud — a missing agent,
// undeployed surface, or unreachable server prints one clear line and exits
// non-zero, never throws.
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
  const eff = sat.effectiveCapabilities(cfg.get("dispatch.capabilities", {}) || {});
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
    group: "Getting started", parse: "strict", args: "<url> <token>", aliases: ["login"],
    summary: "point the client at a graph (writes user config)",
    help: "Write a team-graph server URL and token to your USER config (never a\ncommittable repo config), then confirm the connection immediately. The URL and\ntoken may be given positionally or as --server/--token.",
    options: {
      server: { type: "string", value: "url", desc: "server URL (else the first positional)" },
      token: { type: "string", value: "tok", desc: "auth token (else the second positional)" },
    },
    examples: ["spor join https://graph.example.com tok_abc123"],
    run: (cfg, p) => cmdJoin(cfg, p),
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
    group: "Getting started", parse: "strict", args: "", options: {},
    summary: "who the team graph thinks you are (remote)",
    help: "Echo the identity the server binds to your token (remote mode). In local\nmode it explains there is no server identity.",
    run: (cfg) => cmdWhoami(cfg),
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
    group: "Team admin (remote, admin token)", parse: "raw", args: "list | revoke <prefix>",
    summary: "manage tokens (list, revoke)",
    help: "List or revoke team tokens. Remote + admin only.\n\n  spor token list              show all tokens (hash prefix, person, expiry)\n  spor token revoke <prefix>   revoke the token with that hash prefix",
    examples: ["spor token list", "spor token revoke a1b2c3"],
    run: (cfg, args) => cmdToken(cfg, args),
  },
  agent: {
    group: "Team admin (remote, admin token)", parse: "raw", args: "create <label> [--owner <id>] [--pubkey <fp>] | list | use <agent-id>",
    summary: "person-owned automation principals (dispatch identity)",
    help:
      "Create and list agents — first-class `type: agent` nodes owned by a person\n" +
      "(dec-spor-agent-identity-nodes). A dispatched session runs AS its agent, so its\n" +
      "writes read \"agent on behalf of person\" rather than person-direct. One durable\n" +
      "agent per machine/install, reused across dispatches.\n\n" +
      "  spor agent create <label>     create the agent + its owned-by edge to a person\n" +
      "      --owner <person-id>       owner (remote: defaults to your person; local:\n" +
      "                                defaults to the sole person node, else required)\n" +
      "      --pubkey <fingerprint>    record a public-key fingerprint (forward-compat,\n" +
      "                                unenforced — may be omitted)\n" +
      "  spor agent list               list agents and their owners\n" +
      "  spor agent use <agent-id>     make it THIS machine's default dispatch identity\n" +
      "                                (writes dispatch.agent to your user config; pass\n" +
      "                                --clear to go back to person-scoped dispatch)\n\n" +
      "'use' is a local config write, not a graph write — it sets which agent\n" +
      "`spor dispatch` runs as by default (override one dispatch with 'dispatch --as').\n" +
      "Create/list run remote (POST /v1/admin/agents, admin-gated, the server mints the\n" +
      "spiffe); local mode writes the node + owned-by edge to the graph home.",
    examples: ["spor agent create anthony-laptop", "spor agent use agent-anthony-laptop", "spor agent list"],
    run: (cfg, args) => cmdAgent(cfg, args),
  },

  // --- Graph ---
  add: {
    group: "Graph", parse: "strict", args: '"<text>"', aliases: ["capture"],
    summary: "capture a node (local: typed file; remote: /v1/capture)",
    help:
      "Capture a node from prose. In remote mode the server's ingestion model types\n" +
      "and links it; in local mode a well-formed, validated node file is written so\n" +
      "you never hand-author frontmatter. --type/--title/--id apply to local mode.",
    options: {
      type: { type: "string", value: "T", desc: "node type (local only; default: task)" },
      title: { type: "string", value: "...", desc: "title (default: first 10 words)" },
      project: { type: "string", value: "S", desc: "project slug (default: inferred from cwd)" },
      id: { type: "string", value: "id", desc: "explicit node id (local only)" },
    },
    examples: ['spor add "Cache tf-idf norms across compiles for speed" --type task'],
    run: (cfg, p) => cmdAdd(cfg, p),
  },
  next: {
    group: "Graph", parse: "raw", args: "[--project S | --all-projects] [--type T] [--exclude-type T]", aliases: ["queue"],
    summary: "the decision queue (local: lib/queue; remote: /v1/queue)",
    help: "Show the ranked decision queue. Remote mode reads /v1/queue; local mode is a\nbyte-identical passthrough to lib/queue.js, so it also accepts that script's\nflags (--days, --no-front, --limit, --name-only, --nodes).\n\nSCOPE. --project accepts a repo slug (-> its home-project grouping union), a\nrepo-<slug> node id (-> that single repo), or a grouping id (-> the grouping\nunion); an unknown token warns and yields an empty queue. Pin a default scope\nfor both modes with the queue.project config key (SPOR_QUEUE_PROJECT or\n.spor.json {\"queue\":{\"project\":\"...\"}}); an explicit --project still wins.\n--all-projects (alias --all) widens to the whole-graph cross-project firehose,\ndropping the cwd/pinned default scope (an explicit --project still wins over it).\n\nNODE TYPES. --type/--exclude-type whitelist/blacklist node types from the\nranking; both are repeatable and comma-splittable (--type task,issue). Given\nboth, the include set is narrowed and then the excludes are removed (exclude\nwins on overlap). They compose with --project/--all-projects.\n\nIN-FLIGHT. --json stamps each item with an `in_flight` flag (and a `dispatched`\nagent summary when true) by cross-referencing live background agents from\n`claude agents --json` — `spor dispatch` names each agent after its node id, so\nan active agent on a queued item is detectable without model guidance.\n--hide-dispatched drops the items that already have an agent in flight. Both are\nclient-side (the server can't see local agents) and fail soft when the claude\nbinary is absent (every item then reads in_flight:false).",
    options: {
      project: { type: "string", value: "S", desc: "scope to a project slug (default: queue.project config, else inferred)" },
      "all-projects": { type: "boolean", desc: "cross-project firehose — drop the default project scope (alias --all)" },
      type: { type: "string", value: "T", desc: "include only these node types (repeatable, comma-ok)" },
      "exclude-type": { type: "string", value: "T", desc: "exclude these node types from the ranking (repeatable, comma-ok)" },
      json: { type: "boolean", desc: "machine-readable JSON output (adds the in_flight flag per item)" },
      "hide-dispatched": { type: "boolean", desc: "drop items that already have a background agent in flight" },
    },
    examples: ["spor next", "spor next --json", "spor next --json --hide-dispatched", "spor next --all-projects --type task,issue", "spor next --exclude-type capture-pending"],
    run: (cfg, args) => cmdNext(cfg, args),
  },
  get: {
    group: "Graph", parse: "strict", args: "<id>", options: {},
    summary: "a node by id (local: file; remote: /v1/nodes/<id>)",
    help: "Print one node's raw markdown by id. Remote mode reads /v1/nodes/<id>; local\nmode reads the node file. A missing node exits 1.",
    examples: ["spor get dec-cc-zero-dep-client"],
    run: (cfg, p) => cmdGet(cfg, p),
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
  query: {
    group: "Graph", parse: "raw", args: "[--type T] [--where k=v] [--edges]",
    summary: "filterable node/edge enumeration (local)",
    help:
      "Deterministic, filterable enumeration over the local graph — the structured\n" +
      "list that `get` (one node), `next` (the ranked queue) and `compile --query`\n" +
      "(semantic search) are not. Pure, no LLM. Local-only — it reads the local nodes\n" +
      "dir; in remote mode use the server's saved `render_lens` views instead (point\n" +
      "--nodes at a local checkout to query one under a server).\n" +
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
      "ranked item NOT already in flight on this machine), or --backfill (onboard/\n" +
      "repair a repo). The target dir is the\n" +
      "slug->path map ('spor repos'), overridable with --dir.\n\n" +
      "In remote mode a node dispatch auto-claims the task — it establishes the\n" +
      "heartbeat lease at dispatch time, so concurrent dispatch of the same node is\n" +
      "refused (the holder is named). --no-claim opts out (dispatch with no lease).\n\n" +
      "A node dispatch is also refused if an agent for that node is already in flight\n" +
      "on THIS machine (each agent is named after its node id) — catches the\n" +
      "same-person duplicate the lease's idempotent renew can't. --force overrides.\n\n" +
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
      force: { type: "boolean", desc: "dispatch even if an agent for this node is already in flight here" },
      "from-queue": { type: "boolean", desc: "dispatch the top-ranked queue item not already in flight here" },
      backfill: { type: "boolean", desc: "onboard/repair this repo (runs /spor:backfill)" },
      print: { type: "boolean", desc: "dry run — print the prompt, launch nothing" },
      "dry-run": DRYRUN_OPT,
    },
    examples: ['spor dispatch "rotate the pipeline auth tokens" --dir ../api', "spor dispatch dec-x --model haiku", "spor dispatch --from-queue --print"],
    run: (cfg, p) => cmdDispatch(cfg, p),
  },
  repos: {
    group: "Dispatch (Claude Code background agents)", parse: "raw", args: "[list | add <slug> <path> | rm <slug>]",
    summary: "the local slug->repo-dir map used to pick the dispatch directory",
    help: "Show or edit the per-machine slug->repo-dir map dispatch uses to find a repo.\nThe map self-registers as you open sessions.\n\n  spor repos                 list the map\n  spor repos add <slug> <p>  map a slug to a path\n  spor repos rm <slug>       forget a mapping",
    examples: ["spor repos", "spor repos add api ~/code/api"],
    run: (cfg, args) => cmdRepos(cfg, args),
  },
  capabilities: {
    group: "Dispatch (Claude Code background agents)", parse: "raw", aliases: ["caps", "profiles"],
    args: "[list [--json] | probe | publish | set <axis> <v...> | allow-mcp <m...> | deny <profile-id...> | clear]",
    summary: "this machine's dispatch capability map (profile satisfiability)",
    help:
      "Show or edit the per-machine capability map dispatch matches against an\n" +
      "agent's profile (dec-spor-machine-profile-satisfiability). Harnesses, plugins,\n" +
      "and skills self-probe each session; declare what a probe can't decide (reachable\n" +
      "MCP, deny-flags). Declared augments probed; deny overrides both. Stored in the\n" +
      "machine-local config.json, never a committed .spor.json.\n\n" +
      "  spor capabilities                  show effective capabilities\n" +
      "  spor capabilities probe            re-probe harnesses/plugins/skills now\n" +
      "  spor capabilities publish          push them to the team fleet scheduler (remote)\n" +
      "  spor capabilities set <axis> <v…>  declare an axis (replaces)\n" +
      "  spor capabilities add|rm <axis> <v…>  adjust a declared axis\n" +
      "  spor capabilities allow-mcp <name…>   declare a reachable MCP server\n" +
      "  spor capabilities deny|undeny <profile-id…>  policy opt-out of a profile\n" +
      "  spor capabilities clear            reset declarations + probe cache\n\n" +
      "publish is the remote twin: it sends this box's effective capabilities to the\n" +
      "server (keyed on dispatch.agent) so the fleet scheduler can route an assigned\n" +
      "profile to a box that can satisfy it — substitution-free re-routing across\n" +
      "machines. Run `spor agent use <agent-id>` once to set this box's agent first.\n\n" +
      `  axes: ${sat.CAP_AXES.join(", ")}`,
    examples: ["spor capabilities", "spor capabilities allow-mcp spor", "spor capabilities publish"],
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

async function main() {
  const argv = process.argv.slice(2);
  const verb = argv.shift();
  const args = argv;
  const cfg = loadConfig({ cwd: process.cwd() });

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
module.exports = { nodeFloor, nodeRuntimeCheck, verCmp, sporConnectorBound };

if (require.main === module) {
  main()
    .then((code) => process.exit(code || 0))
    .catch((e) => {
      err(`spor: ${e && e.message ? e.message : String(e)}`);
      process.exit(1);
    });
}
