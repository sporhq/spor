"use strict";

// Coding-agent CLI adapters for `spor dispatch`. Keep harness-specific argv,
// validation, session-event parsing, and discovery declarations here; the CLI
// owns the common briefing/profile/claim/worktree/supervision lifecycle.

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

module.exports = { getHarness, harnesses };
