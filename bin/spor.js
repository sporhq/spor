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
  whoami               who the team graph thinks you are (remote)

Graph
  next [--project S]   the decision queue (local: lib/queue; remote: /v1/queue)
  get <id>             a node by id (local: file; remote: /v1/nodes/<id>)
  compile <args>       full neighborhood / digest (local; byte-identical)
  brief <id>           compile a briefing for a node (alias: compile --root <id>)
  validate             lint the local graph (byte-identical)

Other
  version              print version
  help                 this message

Mode is set by config/env (SPOR_SERVER ⇒ remote). See 'spor status'.`;

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

function safeSlug() {
  try {
    return u.projectSlug(process.cwd());
  } catch {
    return path.basename(process.cwd()) || "project";
  }
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
