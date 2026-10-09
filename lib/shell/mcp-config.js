"use strict";
// shell/mcp-config.js — the ONE writer of the token-bearing MCP config a
// Claude Code harness reads its Spor server from (`--mcp-config`,
// dec-spor-session-identity-active-record). `spor dispatch` writes it under
// the graph home's outbox (writeDispatchMcpConfig in bin/spor.js) and `spor
// attempt run` into a private temp dir inside the environment
// (lib/shell/attempt.js); both build the file here, so the two can never
// disagree about its shape (task-spor-work-derive-attempt-spec-on-dispatch).
//
// Which servers it names is the attempt spec's MCP axis (PROVIDERS.md §4,
// `mcp`): of the names the axis asks for, Spor wires the ones it can
// configure itself — today `spor`, with the run's token — and every other
// name is reachable only if the ENVIRONMENT provides it (the provider's
// `reachable_mcp` capability, matched before submit).

const fs = require("node:fs");

const SPOR_MCP_NAME = "spor";

// {conf, wired, external} for an MCP axis, or conf null when nothing on it is
// Spor's to wire (or there is no server/token to wire it with).
function mcpConfigFor(mcp, { server, token }) {
  const names = Array.isArray(mcp) ? mcp.filter((m) => typeof m === "string" && m) : [];
  const wired = names.includes(SPOR_MCP_NAME) && server && token ? [SPOR_MCP_NAME] : [];
  const external = names.filter((m) => m !== SPOR_MCP_NAME);
  if (!wired.length) return { conf: null, wired, external };
  const conf = {
    mcpServers: {
      spor: {
        type: "http",
        url: `${String(server).replace(/\/+$/, "")}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
  return { conf, wired, external };
}

// Write `conf` to `file`: 0600 from creation, with O_EXCL so a pre-placed
// file or symlink at the path is REFUSED rather than written through — the
// file holds a live bearer token.
function writeMcpConfigFile(file, conf) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(conf, null, 2) + "\n");
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

module.exports = { SPOR_MCP_NAME, mcpConfigFor, writeMcpConfigFile };
