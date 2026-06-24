// Spor adapter for OpenCode (dec-cc-portable-core-adapters).
//
// OpenCode has no command-hook system; plugins are in-process JS. This one
// stays a thin shim over the same portable core every other host uses: each
// hook synthesizes a Claude-shaped payload and launches the Node dispatcher
// (bin/spor-hook.js), so briefing/digest/journal/distill behavior is
// identical across hosts.
//
//   chat.message        -> session-start briefing (first message of a session)
//                          + per-prompt relevance digest, appended as a
//                          synthetic text part (the additionalContext analog)
//   tool.execute.after  -> post-tool journal for write/edit
//   event session.idle  -> export the session as a Claude-shaped transcript,
//                          hand it to the debounced distiller (session.idle
//                          fires every turn; the watcher distills on quiesce)
//
// Fail open (dec-cc-fail-open-hooks): every path swallows errors and injects
// nothing. Zero dependencies: node builtins only.
//
// Install: symlink this file into ~/.config/opencode/plugins/ (the symlink is
// resolved to find bin/spor-hook.js), or copy it and set SPOR_ROOT (legacy
// SUBSTRATE_ROOT still read).

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

// Dual-read for the Spor rename: SPOR_* wins, legacy SUBSTRATE_* still works;
// default graph home is ~/.spor, falling back to an existing ~/.substrate.
const GRAPH =
  process.env.SPOR_HOME ||
  process.env.SUBSTRATE_HOME ||
  (existsSync(join(homedir(), ".spor")) || !existsSync(join(homedir(), ".substrate"))
    ? join(homedir(), ".spor")
    : join(homedir(), ".substrate"))
const DEBOUNCE = process.env.SPOR_DEBOUNCE || process.env.SUBSTRATE_DEBOUNCE || "900"
const EMBEDDED_ROOT = "__SPOR_ROOT__"

function findDispatcher() {
  const candidates = []
  const root =
    process.env.SPOR_ROOT ||
    process.env.SUBSTRATE_ROOT ||
    (EMBEDDED_ROOT !== "__SPOR_ROOT__" ? EMBEDDED_ROOT : "")
  if (root) {
    candidates.push(join(root, "bin", "spor-hook.js"))
  }
  try {
    const here = dirname(realpathSync(fileURLToPath(import.meta.url)))
    candidates.push(join(here, "..", "..", "bin", "spor-hook.js"))
  } catch {}
  return candidates.find((c) => existsSync(c)) || null
}

// Run the dispatcher with a payload on stdin; resolve to stdout ("" on any
// failure or timeout — never reject).
function run(bin, args, payload, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (out) => { if (!done) { done = true; resolve(out) } }
    try {
      const child = spawn(process.execPath, [bin, ...args], { stdio: ["pipe", "pipe", "ignore"] })
      let out = ""
      const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch {}; finish("") }, timeoutMs)
      child.stdout.on("data", (d) => { out += d })
      child.on("error", () => { clearTimeout(timer); finish("") })
      child.on("close", () => { clearTimeout(timer); finish(out) })
      child.stdin.on("error", () => {})
      child.stdin.end(JSON.stringify(payload))
    } catch {
      finish("")
    }
  })
}

export const SporPlugin = async ({ client, directory }) => {
  const BIN = findDispatcher()
  if (!BIN) return {} // no core checkout found: disable silently, fail open

  const briefed = new Set()

  async function inject(parts, event, payload, timeoutMs) {
    const out = await run(BIN, [event, "--host", "opencode"], payload, timeoutMs)
    if (!out) return
    try {
      const ctx = JSON.parse(out)?.hookSpecificOutput?.additionalContext
      if (ctx) parts.push({ type: "text", text: ctx, synthetic: true })
    } catch {}
  }

  return {
    "chat.message": async (input, output) => {
      try {
        const sid = input?.sessionID || output?.message?.sessionID || "unknown"
        const prompt = (output?.parts || [])
          .filter((p) => p?.type === "text" && p.text && !p.synthetic)
          .map((p) => p.text)
          .join("\n")
        if (!briefed.has(sid)) {
          briefed.add(sid)
          await inject(output.parts, "session-start",
            { cwd: directory, session_id: sid, hook_event_name: "SessionStart" }, 20000)
        }
        // The trivial-prompt gate (>=6 words, not a /command) lives in the engine.
        await inject(output.parts, "prompt-context",
          { cwd: directory, session_id: sid, prompt, hook_event_name: "UserPromptSubmit" }, 15000)
      } catch {}
    },

    "tool.execute.after": async (input) => {
      try {
        if (input?.tool !== "write" && input?.tool !== "edit") return
        const file = input?.args?.filePath || input?.args?.file_path
        if (!file) return
        await run(BIN, ["post-tool", "--host", "opencode"], {
          cwd: directory,
          session_id: input.sessionID || "unknown",
          tool_name: input.tool,
          tool_input: { file_path: file },
          hook_event_name: "PostToolUse",
        }, 10000)
      } catch {}
    },

    event: async ({ event }) => {
      try {
        if (event?.type !== "session.idle") return
        const sid = event.properties?.sessionID || event.properties?.id
        if (!sid) return
        // Export the session as a Claude-shaped transcript so the distill
        // engine's primary parser (not the generic fallback) handles it.
        const resp = await client.session.messages({ path: { id: sid } })
        const msgs = resp?.data || (Array.isArray(resp) ? resp : [])
        const lines = []
        for (const m of msgs) {
          const info = m?.info || m
          const text = (m?.parts || [])
            .filter((p) => p?.type === "text" && p.text)
            .map((p) => p.text)
            .join("\n")
          if (!text) continue
          const role = info?.role === "assistant" ? "assistant" : "user"
          lines.push(JSON.stringify({ type: role, message: { content: [{ type: "text", text }] } }))
        }
        if (!lines.length) return
        mkdirSync(join(GRAPH, "journal"), { recursive: true })
        const transcript = join(GRAPH, "journal", `opencode-${sid}.transcript.jsonl`)
        writeFileSync(transcript, lines.join("\n") + "\n")
        await run(BIN, ["distill", "--host", "opencode", "--debounce", DEBOUNCE], {
          cwd: directory,
          session_id: sid,
          transcript_path: transcript,
          hook_event_name: "SessionEnd",
        }, 10000)
      } catch {}
    },
  }
}
