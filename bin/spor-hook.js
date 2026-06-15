#!/usr/bin/env node
"use strict";
// spor-hook — host-agnostic hook entry point (dec-cc-portable-core-
// adapters). Node port of the bash dispatcher: same I/O contract
// (Claude-shaped JSON on stdin, {hookSpecificOutput: {hookEventName,
// additionalContext}} on stdout), same host normalizations (cursor/copilot
// payload mapping, tool_input.path -> file_path fold), same debounce spool
// for turn-scoped hosts — but the engines run in-process and the watcher is
// a detached Node child, so the whole path needs no bash, jq, curl, or
// setsid and runs natively on Windows, macOS, and Linux.
//
// Usage (from a host's hooks config; see adapters/):
//   spor-hook session-start  [--host claude-code|codex|gemini|cursor|copilot|opencode]
//   spor-hook prompt-context [--host ...]
//   spor-hook post-tool      [--host ...]
//   spor-hook distill        [--host ...] [--debounce SECONDS]
//   spor-hook agents-md      [--cwd DIR]    # AGENTS.md floor; no stdin
//   spor-hook doctor         [--cwd DIR]    # client health report; no stdin
//
// Fail-open contract (dec-cc-fail-open-hooks): any failure exits 0 with no
// output — a Spor problem never costs the user their session.

const fs = require("fs");
const path = require("path");
const u = require(path.join(__dirname, "..", "scripts", "engines", "util"));

const ENGINES = {
  "session-start": () => require("../scripts/engines/session-start").sessionStart,
  "prompt-context": () => require("../scripts/engines/prompt-context").promptContext,
  "post-tool": () => require("../scripts/engines/post-tool").postTool,
  distill: () => require("../scripts/engines/distill").distill,
};

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

// Payload normalization. The fields the engines consume (cwd, session_id,
// prompt, tool_name, tool_input, transcript_path) are identical across
// claude-code / codex / gemini; cursor and copilot rename them and are
// mapped onto the canonical shape here.
function normalize(payload, host) {
  if (host === "cursor") {
    // conversation_id is the stable per-session key; afterFileEdit carries a
    // bare file_path, synthesized into a tool_input for the journal engine.
    payload.cwd = payload.cwd ?? payload.workspace_roots?.[0] ?? null;
    payload.session_id = payload.conversation_id ?? payload.session_id ?? null;
    if (payload.hook_event_name === "afterFileEdit" && payload.file_path != null) {
      payload.tool_name = payload.tool_name ?? "edit";
      payload.tool_input = { file_path: payload.file_path };
    }
  } else if (host === "copilot") {
    payload.session_id = payload.session_id ?? payload.sessionId ?? null;
    payload.tool_name = payload.tool_name ?? payload.toolName ?? null;
    payload.tool_input = payload.tool_input ?? payload.toolArgs ?? null;
    payload.transcript_path = payload.transcript_path ?? payload.transcriptPath ?? null;
  }
  // Some hosts' file tools carry the path as tool_input.path (Codex
  // apply_patch, Copilot toolArgs); fold it into the canonical file_path.
  if (
    payload.tool_input &&
    typeof payload.tool_input === "object" &&
    !Array.isArray(payload.tool_input) &&
    payload.tool_input.file_path == null &&
    payload.tool_input.path != null
  ) {
    payload.tool_input.file_path = payload.tool_input.path;
  }
  return payload;
}

async function main() {
  const argv = process.argv.slice(2);
  const event = argv.shift() ?? "";
  let host = "claude-code";
  let debounce = 0;
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host") {
      host = argv[++i] ?? "claude-code";
    } else if (argv[i] === "--debounce") {
      debounce = Number(argv[++i] ?? 0) || 0;
    } else {
      args.push(argv[i]);
    }
  }

  if (event === "agents-md") {
    const { agentsMd } = require("../scripts/engines/agents-md");
    // Wired as a host's session-start hook the payload arrives on stdin;
    // standalone runs (TTY) take --cwd or $PWD without waiting on stdin.
    let payload = null;
    if (!process.stdin.isTTY && !args.includes("--cwd")) {
      const raw = await readStdin();
      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch {}
      }
    }
    // Active config (dec-spor-client-config-cascade): a per-repo `enabled:false`
    // / `mode:off` makes the plugin a no-op in unrelated side projects.
    let amdCwd = process.cwd();
    const ci = args.indexOf("--cwd");
    if (ci >= 0 && args[ci + 1]) amdCwd = args[ci + 1];
    else if (payload && payload.cwd) amdCwd = payload.cwd;
    if (!u.useConfig({ cwd: amdCwd }).enabled()) return;
    await agentsMd(payload, args);
    return;
  }

  // `spor-hook doctor` (task-cc-client-hook-operability-diagnostics piece 3):
  // an operator-run diagnostic, not a host hook — it takes no stdin and prints a
  // human-readable health report. It runs even when the plugin is disabled for
  // the repo (a disabled plugin is exactly what you'd want doctor to tell you).
  // Write the report with fs.writeSync(1) so the full body flushes before the
  // crash handler's process.exit(0) can truncate a piped stdout.
  if (event === "doctor") {
    const { doctor } = require("../scripts/engines/doctor");
    let dCwd = process.cwd();
    const ci = args.indexOf("--cwd");
    if (ci >= 0 && args[ci + 1]) dCwd = args[ci + 1];
    u.useConfig({ cwd: dCwd });
    const report = await doctor();
    fs.writeSync(1, report);
    return;
  }

  if (!(event in ENGINES)) {
    process.stderr.write(`spor-hook: unknown event '${event}'\n`);
    return;
  }

  const raw = await readStdin();
  if (!raw) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;
  payload = normalize(payload, host);

  // Active config (dec-spor-client-config-cascade), anchored at the session
  // cwd so the nearest-ancestor .spor.json is in scope. A per-repo
  // `enabled:false` / `mode:off` makes every hook a no-op (exit 0, no output)
  // so an unrelated side project doesn't pollute the shared graph neighborhood;
  // default-enabled, so a repo without config is byte-identical to before.
  const cfg = u.useConfig({ cwd: payload.cwd || process.cwd() });
  if (cfg.warnings.length) {
    try {
      const log = u.makeLogger(path.join(u.graphHome(), "journal", "remote.log"), "config: ");
      for (const w of cfg.warnings) log(w);
    } catch {
      /* logging must never break fail-open */
    }
  }
  if (!cfg.enabled()) return;

  // Debounced distill: spool the payload and hand off to a per-session
  // watcher (one at a time — the lock holds the watcher's pid; stale locks
  // from a dead watcher are reclaimed). The watcher fires after quiesce.
  if (event === "distill" && debounce > 0) {
    const graph = u.graphHome();
    const session = payload.session_id ?? "unknown";
    const pend = path.join(graph, "journal", "pending-distill");
    if (!u.ensureDir(pend)) return;
    const pendingFile = path.join(pend, `${session}.json`);
    try {
      fs.writeFileSync(pendingFile, JSON.stringify(payload));
    } catch {
      return;
    }
    const lock = path.join(pend, `${session}.lock`);
    try {
      const pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8"));
      try {
        process.kill(pid, 0);
      } catch {
        fs.rmSync(lock, { recursive: true, force: true }); // stale lock
      }
    } catch {}
    try {
      fs.mkdirSync(lock);
    } catch {
      return; // a live watcher holds the lock
    }
    u.spawnDetached([
      path.join(__dirname, "..", "scripts", "engines", "debounce-watcher.js"),
      pendingFile,
      lock,
      String(debounce),
    ]);
    return;
  }

  const engine = ENGINES[event]();
  const out = await engine(payload);
  if (!out) return;

  // Cursor speaks a flat snake_case output: {additional_context} only.
  // (jq -c framing: compact JSON with a trailing newline.)
  if (host === "cursor") {
    const ctx = out.hookSpecificOutput?.additionalContext;
    if (ctx !== undefined) process.stdout.write(JSON.stringify({ additional_context: ctx }) + "\n");
    return;
  }

  // Envelope: echo the host's own event name back into hookEventName. Every
  // current host sends hook_event_name; the bash dispatcher compacted the
  // envelope through jq -c on this path, and that compact-plus-newline form
  // is the wire contract this port preserves.
  const ev = payload.hook_event_name;
  if (ev && out.hookSpecificOutput) out.hookSpecificOutput.hookEventName = ev;
  process.stdout.write(JSON.stringify(out) + "\n");
}

// Degradation telemetry (issue-cc-fail-open-degradation-telemetry-gap,
// task-cc-client-hook-operability-diagnostics piece 1): the fail-open contract
// (dec-cc-fail-open-hooks) says a crashing engine and a quiet success look
// identical from the outside — a symptom-free hook is also what a black hole
// looks like. Before honoring that contract (exit 0, no output), append ONE
// best-effort line to journal/remote.log so an operator can tell a crash apart
// from healthy silence after the fact. Wrapped so a logging failure can never
// itself break the exit-0 guarantee.
function logCrash(err) {
  try {
    const event = process.argv[2] || "?";
    const graph = u.graphHome();
    u.ensureDir(path.join(graph, "journal"));
    const log = u.makeLogger(path.join(graph, "journal", "remote.log"), `dispatcher ${event}: `);
    const msg = (err && (err.stack || err.message)) || String(err);
    log(`crashed (fail-open, exit 0): ${String(msg).split("\n")[0]}`);
  } catch {
    /* logging must never break fail-open */
  }
}

// Run only when invoked as the entry point; `require()` (the crash-handler
// test) just gets logCrash without spawning the dispatcher.
if (require.main === module) {
  main()
    .catch((err) => logCrash(err))
    .finally(() => process.exit(0));
}

module.exports = { logCrash };
