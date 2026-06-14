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
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const { loadConfig } = require(path.join(ROOT, "lib", "config.js"));
const remote = require(path.join(ROOT, "lib", "remote.js"));
const u = require(path.join(ROOT, "scripts", "engines", "util.js"));

const HELP = `spor — Spor client CLI

Usage: spor <verb> [args]

Getting started
  init                 create the local graph home (nodes/, git, .gitignore)
  status               resolved mode, graph, project, identity, health
  join <url> <token>   point the client at a graph (writes user config)
  whoami               who the team graph thinks you are (remote)

Graph
  add "<text>"         capture a node (local: typed file; remote: /v1/capture)
  next [--project S]   the decision queue (local: lib/queue; remote: /v1/queue)
  get <id>             a node by id (local: file; remote: /v1/nodes/<id>)

Repo scoping
  disable | enable     turn Spor off/on for this repo (.spor.json)
  link <slug>          set this repo's canonical project slug (.spor marker)
  compile <args>       full neighborhood / digest (local; byte-identical)
  brief <id>           compile a briefing for a node (alias: compile --root <id>)
  validate             lint the local graph (byte-identical)

Other
  version              print version
  help                 this message

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

function cmdInit(cfg) {
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
  out(`${created ? "Created" : "Graph already present at"} ${home}`);
  out(`  nodes:  ${nodesDir} (${nodeCount(nodesDir) ?? 0} nodes)`);
  out(`  mode:   ${cfg.mode()}`);
  out(created ? `\nNext: start a session here, or 'spor next' to see the queue.` : "");
  return 0;
}

async function cmdStatus(cfg) {
  const mode = cfg.mode();
  const home = cfg.graphHome();
  const nodesDir = cfg.nodesDir();
  const slug = safeSlug();
  out(`mode:     ${mode}${cfg.enabled() ? "" : "  (DISABLED here — plugin is a no-op)"}`);
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
    if (p) return `${p}${r.json.email ? ` <${r.json.email}>` : ""}${bound === false ? "  ⚠ token maps to NO person node" : ""}`;
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
  if (cfg.mode() === "remote") {
    const pi = args.indexOf("--project");
    const slug = pi >= 0 && args[pi + 1] ? args[pi + 1] : safeSlug();
    const r = await remote.get(cfg, `/v1/queue?project=${encodeURIComponent(slug)}&limit=10`, { timeoutMs: 6000 });
    if (r.transport) {
      err(`offline — could not reach server (${r.error})`);
      return 1;
    }
    if (!r.ok) {
      err(`queue error ${r.status}`);
      return 1;
    }
    if (args.includes("--json")) {
      out(JSON.stringify(r.json));
      return 0;
    }
    renderQueue(r.json);
    return 0;
  }
  return passthrough("queue.js", args); // local: byte-identical
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

async function cmdGet(cfg, args) {
  const id = args[0];
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

function cmdCompile(cfg, verb, args) {
  // brief <id> is sugar for compile --root <id>.
  if (verb === "brief") {
    const id = args[0];
    if (!id) {
      err("usage: spor brief <id>");
      return 1;
    }
    return passthrough("compile.js", ["--root", id, ...args.slice(1)]);
  }
  return passthrough("compile.js", args);
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

async function cmdAdd(cfg, args) {
  const prose = args.find((a) => !a.startsWith("--"));
  if (!prose) {
    err('usage: spor add "<text>" [--type T] [--title ...] [--project S]');
    return 1;
  }
  const project = optVal(args, "project") || safeSlug();

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
  const type = optVal(args, "type") || "task";
  const title = optVal(args, "title") || prose.split(/\s+/).slice(0, 10).join(" ");
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
  let id = optVal(args, "id") || `${prefix}${kebab(title) || today()}`;
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

// --- spor join / login --------------------------------------------------
// Write server+token to USER config (never a committable repo config), then
// confirm immediately — the upgrade research found no one-step way to point a
// client at a graph and know it took.
async function cmdJoin(cfg, args) {
  const positional = args.filter((a) => !a.startsWith("--"));
  const server = optVal(args, "server") || positional[0];
  const token = optVal(args, "token") || positional[1];
  if (!server) {
    err("usage: spor join <server-url> <token>");
    return 1;
  }
  const home = cfg.graphHome();
  const cfgFile = path.join(home, "config.json");
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(cfgFile, "utf8")) || {};
  } catch {
    /* absent or malformed — start fresh */
  }
  data.server = server.replace(/\/+$/, "");
  if (token) data.token = token;
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify(data, null, 2) + "\n");
  } catch (e) {
    err(`could not write ${cfgFile}: ${e.message}`);
    return 1;
  }
  out(`wrote server${token ? " + token" : ""} to ${cfgFile}`);
  if (!token) out(`note: no token given — set SPOR_TOKEN or 'spor join <server> <token>' to authenticate`);
  // confirm against the freshly-written config
  const fresh = loadConfig({ cwd: process.cwd() });
  return await cmdStatus(fresh);
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
  out(`  ${file}${enabled ? "" : " — hooks are now a no-op here; commit it to share the setting"}`);
  return 0;
}

// --- spor link <slug>: write the .spor identity marker --------------------
// Fixes a wrong inferred slug (basename != canonical) deterministically,
// instead of waiting for the server's fingerprint-alias proposal to be approved.
function cmdLink(args) {
  const slug = args.find((a) => !a.startsWith("--")) || safeSlug();
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

function version() {
  try {
    return require(path.join(ROOT, "package.json")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const verb = argv.shift();
  const args = argv;
  const cfg = loadConfig({ cwd: process.cwd() });

  switch (verb) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      out(HELP);
      return 0;
    case "version":
    case "--version":
    case "-v":
      out(version());
      return 0;
    case "init":
      return cmdInit(cfg);
    case "status":
      return await cmdStatus(cfg);
    case "whoami":
      return await cmdWhoami(cfg);
    case "join":
    case "login":
      return await cmdJoin(cfg, args);
    case "add":
    case "capture":
      return await cmdAdd(cfg, args);
    case "enable":
      return cmdScope(true);
    case "disable":
      return cmdScope(false);
    case "link":
      return cmdLink(args);
    case "next":
    case "queue":
      return await cmdNext(cfg, args);
    case "get":
      return await cmdGet(cfg, args);
    case "compile":
    case "brief":
      return cmdCompile(cfg, verb, args);
    case "validate":
      return passthrough("validate.js", args);
    default:
      err(`spor: unknown verb '${verb}'. Try 'spor help'.`);
      return 1;
  }
}

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    err(`spor: ${e && e.message ? e.message : String(e)}`);
    process.exit(1);
  });
