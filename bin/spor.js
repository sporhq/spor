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
const { spawnSync } = require("child_process");
const { parseArgs } = require("util");

const ROOT = path.resolve(__dirname, "..");
const { loadConfig } = require(path.join(ROOT, "lib", "config.js"));
const remote = require(path.join(ROOT, "lib", "remote.js"));
const u = require(path.join(ROOT, "scripts", "engines", "util.js"));

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

  if (cfg.mode() === "remote") {
    const slug = explicit ?? pinned ?? safeSlug();
    const r = await remote.get(cfg, `/v1/queue?project=${encodeURIComponent(slug)}&limit=10`, { timeoutMs: 6000 });
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
    // is deliberately not flagged — an empty default queue is normal, not a typo.
    const scoped = explicit ?? pinned;
    const count = (r.json && (r.json.count ?? (Array.isArray(r.json.items) ? r.json.items.length : null)));
    if (scoped && count === 0) {
      err(`project '${scoped}' returned an empty queue — check the slug / grouping id (the server scoped to it and found nothing)`);
    }
    if (args.includes("--json")) {
      out(JSON.stringify(r.json));
      return 0;
    }
    renderQueue(r.json);
    return 0;
  }
  // local: byte-identical passthrough. When no --project was given but a default
  // is pinned, inject it so the local read inherits the same default scope as
  // remote; otherwise pass args untouched (preserving the local->global default —
  // we never inject safeSlug() locally).
  const localArgs = !explicit && pinned ? [...args, "--project", pinned] : args;
  return passthrough("queue.js", localArgs);
}

function renderQueue(q) {
  const items = (q && q.items) || [];
  if (!items.length) {
    out("queue empty — nothing queueable and live");
    return;
  }
  for (const it of items) {
    out(`${(it.score ?? 0).toFixed ? it.score.toFixed(2) : it.score}  ${it.suggest || "do"}  ${it.id}`);
    if (it.why) out(`        ${it.why}`);
  }
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
function repoRoot() {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const top = (r.stdout || "").trim();
  return top || process.cwd();
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
  const upd = spawnSync(cmd, ["plugin", "update", "spor", "--scope", cliScope], { stdio: "inherit" });
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
  const plUpd = ["plugin", "update", "spor", "--scope", cliScope];
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

// The single highest-ranked open queue item (for --from-queue). Mode-aware,
// fail-soft (null on any error/empty).
async function topQueueItem(cfg, slug) {
  if (cfg.mode() === "remote") {
    const q = slug ? `?project=${encodeURIComponent(slug)}&limit=1` : "?limit=1";
    const r = await remote.get(cfg, `/v1/queue${q}`, { timeoutMs: 6000 });
    return r.ok && r.json ? (r.json.items || [])[0] || null : null;
  }
  try {
    const g = require(path.join(ROOT, "lib", "graph.js")).loadGraph(cfg.nodesDir());
    const { rankQueue } = require(path.join(ROOT, "lib", "queue.js"));
    const r = rankQueue(g, slug ? { project: slug, limit: 1 } : { limit: 1 });
    return (r.items || [])[0] || null;
  } catch {
    return null;
  }
}

// Resolve the directory to launch in. --dir wins; else a known slug is looked up
// in the map; else the cwd's repo root. { dir:null } means "slug unknown here".
function resolveDir(cfg, { dir, slug }) {
  if (dir) {
    const abs = path.resolve(dir);
    return { dir: abs, slug: slug || u.projectSlug(abs), source: "--dir" };
  }
  if (slug) {
    const p = (cfg.get("dispatch.repos", {}) || {})[slug];
    return p ? { dir: p, slug, source: "config" } : { dir: null, slug, source: "unknown" };
  }
  return { dir: repoRoot(), slug: safeSlug(), source: "cwd" };
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

async function cmdDispatch(cfg, { values, positionals: pos }) {
  const dryRun = !!(values.print || values["dry-run"]);
  const full = !!values.full;
  const noBrief = !!values["no-brief"];
  const backfill = !!values.backfill;
  const fromQueue = !!values["from-queue"];
  const dirOpt = values.dir || null;
  const model = values.model || null;
  const permMode = values["permission-mode"] || null;
  const agent = values.agent || null;
  // A user-supplied prompt template (task-spor-dispatch-user-prompt-templates):
  // --template wins, else a personal default in the config cascade
  // (dispatch.template — an absolute path, like dispatch.repos). Empty until we
  // resolve the file below, so an absent option leaves the prompt byte-identical.
  const templateOpt = values.template || cfg.get("dispatch.template", null);
  let nodeId = values.node || null;
  let targetSlug = values.slug || null;
  let name = values.name || null;

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
  const defaultPrompt = brief
    ? `# Spor briefing (compiled for this task — your standing context)\n\n${brief}\n\n---\n\n# Task\n\n${instruction}\n`
    : instruction;

  // With no template the launched prompt is byte-identical to before. A template
  // takes over entirely: it decides where the compiled brief, the task, and the
  // node metadata land (or wraps the whole default via {{default}}).
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

  const claudeBin = claudeCmd();
  const claudeArgs = ["--bg"];
  if (name) claudeArgs.push("--name", name);
  if (model) claudeArgs.push("--model", model);
  if (permMode) claudeArgs.push("--permission-mode", permMode);
  if (agent) claudeArgs.push("--agent", agent);
  claudeArgs.push(prompt);

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
    if (template != null) out(`template: ${path.resolve(templateOpt)}`);
    out(`run:    ${claudeBin} ${claudeArgs.slice(0, -1).map(shellQuote).join(" ")} <prompt>`);
    out(`\n--- prompt ---\n${prompt}`);
    return 0;
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
  const r = spawnSync(claudeBin, claudeArgs, { cwd: res.dir, stdio: "inherit" });
  if (r.error) {
    err(`could not launch ${claudeBin}: ${r.error.message}`);
    return 1;
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
    group: "Graph", parse: "raw", args: "[--project S]", aliases: ["queue"],
    summary: "the decision queue (local: lib/queue; remote: /v1/queue)",
    help: "Show the ranked decision queue. Remote mode reads /v1/queue; local mode is a\nbyte-identical passthrough to lib/queue.js, so it also accepts that script's\nflags (--days, --no-front, --limit, --name-only, --nodes).\n\n--project accepts a repo slug (-> its home-project grouping union), a repo-<slug>\nnode id (-> that single repo), or a grouping id (-> the grouping union); an\nunknown token warns and yields an empty queue. Pin a default scope for both modes\nwith the queue.project config key (SPOR_QUEUE_PROJECT or .spor.json\n{\"queue\":{\"project\":\"...\"}}); an explicit --project still wins.",
    options: {
      project: { type: "string", value: "S", desc: "scope to a project slug (default: queue.project config, else inferred)" },
      json: { type: "boolean", desc: "machine-readable JSON output" },
    },
    examples: ["spor next", "spor next --project spor --json"],
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
      "ranked item), or --backfill (onboard/repair a repo). The target dir is the\n" +
      "slug->path map ('spor repos'), overridable with --dir.\n\n" +
      "--template supplies your own prompt with {{brief}}/{{task}}/{{node}}/{{title}}/\n" +
      "{{slug}}/{{dir}}/{{default}} placeholders.",
    options: {
      dir: { type: "string", value: "path", desc: "launch directory (overrides the slug map)" },
      node: { type: "string", value: "id", desc: "dispatch a specific node id" },
      slug: { type: "string", value: "slug", desc: "target project slug (cross-repo resolution)" },
      model: { type: "string", value: "M", desc: "claude --model" },
      "permission-mode": { type: "string", value: "P", desc: "claude --permission-mode" },
      agent: { type: "string", value: "A", desc: "claude --agent" },
      name: { type: "string", value: "N", desc: "claude --name (session name)" },
      template: { type: "string", value: "F", desc: "prompt template file (placeholders above)" },
      full: { type: "boolean", desc: "full briefing instead of the digest" },
      "no-brief": { type: "boolean", desc: "raw task prompt, no briefing block" },
      "from-queue": { type: "boolean", desc: "dispatch the top-ranked queue item" },
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
