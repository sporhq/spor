"use strict";

// Coding-agent CLI adapters for `spor dispatch`. Keep harness-specific argv,
// validation, session-event parsing, and discovery declarations here; the CLI
// owns the common briefing/profile/claim/worktree/supervision lifecycle.

const fs = require("fs");
const os = require("os");
const path = require("path");

function tomlString(value) {
  return JSON.stringify(String(value));
}

function claudeArgs({ name, model, permissionMode, agent, mcpConfig, prompt }) {
  const args = ["--bg"];
  if (name) args.push("--name", name);
  if (model) args.push("--model", model);
  if (permissionMode) args.push("--permission-mode", permissionMode);
  if (agent) args.push("--agent", agent);
  if (mcpConfig) args.push("--mcp-config", mcpConfig, "--strict-mcp-config");
  if (prompt != null) args.push(prompt);
  return args;
}

function codexArgs({ model, sandbox, approvalPolicy, reportPath, sporMcp }) {
  const args = [
    "--ask-for-approval", approvalPolicy || "never",
    "exec",
    "--json",
    "--sandbox", sandbox || "workspace-write",
    "--output-last-message", reportPath,
  ];
  if (model) args.push("--model", model);
  if (sporMcp && sporMcp.url) {
    args.push(
      "--config", `mcp_servers.spor.url=${tomlString(sporMcp.url)}`,
      "--config", `mcp_servers.spor.bearer_token_env_var=${tomlString("SPOR_DISPATCH_MCP_TOKEN")}`,
      "--config", "mcp_servers.spor.required=true"
    );
  }
  // stdin carries the compiled prompt so it never appears in argv or process
  // listings. The generic supervisor replaces the report placeholder.
  args.push("-");
  return args;
}

// --- nested Codex-from-Codex sandbox isolation ------------------------------
// (dec-spor-nested-codex-supervisor-provisions-codex-home,
// task-spor-nested-codex-dispatch-sandbox-isolation)
//
// A `spor dispatch --profile profile-codex-sol` run FROM an active Codex
// session inherits that outer session's own sandbox, which mounts `~/.codex`
// read-only — the inner `codex exec` then fails before `thread.started`
// because it cannot initialize its state db there. Per
// dec-spor-dispatch-harness-adapter-contract, "environment ... preparation"
// is the ADAPTER's job, not the shared supervisor's — so this stays here,
// behind one optional `prepareRun` hook the supervisor calls generically
// (agent-dispatch-runner.js's runJob), never a harness id check.
//
// The ordinary (non-nested) case — the real CODEX_HOME already writable, the
// one verified by the live host-shell smoke check — must provision nothing:
// `prepareRun` returns null and the run proceeds exactly as before.

function codexRealHome(env) {
  return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

// The only real proof that a directory is writable is a write that succeeds:
// a permission-bit read means nothing against a read-only bind mount, and a
// missing directory is not evidence of read-only-ness at all — codex has
// simply never run here yet, so there is nothing to isolate FROM (the
// ordinary first-run case must provision nothing, same as an already-writable
// home).
function isWritableDir(dir) {
  if (!fs.existsSync(dir)) return true;
  const probe = path.join(dir, `.spor-write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

// The files an isolated run legitimately needs FROM the real home to
// authenticate/configure — never the whole tree, and copied read-only
// (0o400) so the isolated run can read them but never write back into (or
// through) them into the real home.
const CODEX_HOME_PROJECTION = ["auth.json", "config.toml"];

function projectCodexHome(realHome, isolatedHome) {
  fs.mkdirSync(path.join(isolatedHome, "state"), { recursive: true });
  for (const name of CODEX_HOME_PROJECTION) {
    const src = path.join(realHome, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(isolatedHome, name);
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o400);
  }
}

// Called by the shared supervisor right before it spawns the harness child.
// `scratchDir` is a run-scoped directory the supervisor reserves for adapter
// use and owns the lifecycle of (cleaned up on exit/reconcile/prune) — this
// adapter decides what, if anything, to put there. Returns null when nothing
// needs isolating (byte-identical to the pre-isolation behavior); otherwise
// an env overlay plus a cleanup callback the supervisor runs once the child
// is done with it, so the isolated home never outlives the run it served.
function codexPrepareRun({ env = process.env, scratchDir } = {}) {
  if (!scratchDir) return null;
  const realHome = codexRealHome(env);
  if (isWritableDir(realHome)) return null;
  try {
    projectCodexHome(realHome, scratchDir);
  } catch (e) {
    // A failure partway through (e.g. after auth.json copied but before
    // config.toml) must not leave a half-provisioned scratch dir — with a
    // real credential copy in it — sitting around for the supervisor's own
    // catch-and-swallow to only clean up on the 14-day prune sweep. Remove
    // whatever this attempt managed to write, then let the caller fall back
    // to the (broken but no worse than before this fix) real CODEX_HOME.
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw e;
  }
  return {
    env: { CODEX_HOME: scratchDir },
    cleanup() {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    },
  };
}

const ADAPTERS = Object.freeze({
  "claude-code": Object.freeze({
    id: "claude-code",
    label: "Claude Code",
    launchMode: "native-background",
    identityMode: "mcp-file",
    command: (env = process.env) => env.SPOR_CLAUDE_CMD || "claude",
    activeDiscovery: Object.freeze({ kind: "cli-json", args: ["agents", "--json"] }),
    buildArgs: claudeArgs,
    validateOptions({ sandbox, approvalPolicy }) {
      if (!sandbox && !approvalPolicy) return null;
      const flag = sandbox ? "--sandbox" : "--approval-policy";
      return {
        message: `cannot use ${flag} with a Claude Code dispatch — that flag is Codex-specific.`,
        hint: "use --permission-mode for Claude Code.",
      };
    },
    sessionPreview: "(allocated by claude --bg at launch, bound after)",
    missingBinary: "claude CLI not on PATH — install Claude Code",
  }),
  codex: Object.freeze({
    id: "codex",
    label: "Codex",
    launchMode: "supervised-jsonl",
    identityMode: "env-mcp",
    command: (env = process.env) => env.SPOR_CODEX_CMD || "codex",
    activeDiscovery: Object.freeze({ kind: "run-records" }),
    buildArgs: codexArgs,
    prepareRun: codexPrepareRun,
    validateOptions({ permissionMode, agent }) {
      if (!permissionMode && !agent) return null;
      const flag = permissionMode ? "--permission-mode" : "--agent";
      return {
        message: `cannot use ${flag} with a Codex dispatch — that flag is Claude Code-specific.`,
        hint: "Codex runs unattended with --sandbox workspace-write --approval-policy never by default; override those Codex flags explicitly if needed.",
      };
    },
    sessionFromEvent(event) {
      return event && event.type === "thread.started" ? event.thread_id || null : null;
    },
    sessionPreview: "(read from codex exec thread.started, bound by supervisor)",
    missingBinary: "codex CLI not on PATH — install Codex",
  }),
});

function getHarness(id) {
  return ADAPTERS[id] || null;
}

function harnesses() {
  return Object.values(ADAPTERS);
}

module.exports = { getHarness, harnesses, codexPrepareRun, codexRealHome, isWritableDir };
