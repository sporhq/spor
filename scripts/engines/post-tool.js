"use strict";
// PostToolUse engine (Write|Edit|Bash): journal which files this session
// touched, run the capture nudge on substantial prose writes, and link git
// commits to graph nodes (task-cc-commit-linking). Node port of post-tool.sh
// — same journal line shapes (jq `now|todate` timestamps), same nudge gates
// and cooldowns, same loose-textual-screen + 60s-freshness commit detection.

const fs = require("fs");
const path = require("path");
const u = require("./util");
const { linkCommits, trailerNodeIds } = require("./link-commits");

const NUDGE_CTX = (file, facts) =>
  `[spor capture nudge] The file you just wrote (${file}) contains findings that do not appear to be in the team graph:

${facts}

If a finding is durable, capture it NOW — one /spor:defer (or capture tool) call per finding, in your own words with full context. If none are durable, dismiss this consciously and move on. Live capture beats the session-end backstop: you still have the context the distiller won't. (Classifier: source=nudge; disable with SPOR_NUDGE=0.)`;

// ===FACT===/===END=== blocks -> numbered single-line facts, capped at 3500
// bytes (the awk program joined inner lines with single spaces).
function parseFactList(response) {
  const lines = String(response).split("\n");
  let emit = false;
  let buf = "";
  let n = 0;
  const out = [];
  for (const line of lines) {
    if (line === "===FACT===") {
      emit = true;
      buf = "";
      continue;
    }
    if (line === "===END===") {
      if (emit && buf !== "") {
        n++;
        out.push(`${n}. ${buf}`);
      }
      emit = false;
      continue;
    }
    if (emit) {
      const t = line.replace(/^[ \t]+|[ \t]+$/g, "");
      if (t !== "") buf = buf === "" ? t : `${buf} ${t}`;
    }
  }
  return u.byteHead(out.join("\n") + (out.length ? "\n" : ""), 3500);
}

async function nudge({ input, graph, slug, session, file, remote }) {
  // Nudge on by default; SPOR_NUDGE=0 (env) or nudge.enabled:false (config)
  // disables. No active config falls back to the exact env dual-read.
  if (u.config() ? !u.config().getBool("nudge.enabled", true) : (u.envDual("NUDGE") ?? "1") === "0") return null;
  if (process.env.SPOR_DISTILLING || process.env.SUBSTRATE_DISTILLING) return null; // headless calls don't nudge
  if (!file.endsWith(".md")) return null;
  const home = process.env.HOME || require("os").homedir();
  if (
    file.startsWith(graph + "/") ||
    file.startsWith(path.join(home, ".claude") + "/") ||
    file.includes("/nodes/")
  )
    return null; // graph homes + agent memory
  const base = path.basename(file);
  if (["CLAUDE.md", "AGENTS.md", "GEMINI.md", "MEMORY.md"].includes(base)) return null;
  const tool = input.tool_name ?? "";
  if (!["Write", "Edit", "write", "edit"].includes(tool)) return null;
  // jq -r adds a trailing newline; head -c counts it; $() strips it.
  const rawContent = input.tool_input?.content ?? input.tool_input?.new_string ?? "";
  const content = u.stripTrailingNewlines(u.byteHead(rawContent ? rawContent + "\n" : "", 8000));
  if (u.wordCount(content) < 50) return null; // substantial prose only

  // Cooldown: classify each file at most once per session; at most 3 FIRED
  // nudges per session. State lines are "<facts>\t<file>".
  const state = path.join(graph, "journal", `${session}.nudged`);
  let stateLines = [];
  try {
    stateLines = fs.readFileSync(state, "utf8").split("\n").filter(Boolean);
  } catch {}
  if (stateLines.some((l) => l.split("\t").slice(1).join("\t") === file)) return null;
  if (stateLines.filter((l) => Number(l.split("\t")[0]) > 0).length >= 3) return null;

  const nodes = path.join(graph, "nodes");
  let index = "";
  if (remote) {
    // Cached title index (1h TTL); stale cache beats no index, no index
    // beats blocking the tool loop — the fetch gets 3s, then proceed without.
    const cacheDir = path.join(graph, "cache");
    u.ensureDir(cacheDir);
    const idx = path.join(cacheDir, "index.titles");
    let mtime = 0;
    try {
      mtime = Math.floor(fs.statSync(idx).mtimeMs / 1000);
    } catch {}
    if (Math.floor(Date.now() / 1000) - mtime > 3600) {
      const resp = await u.curl(`${u.serverBase()}/v1/status?titles=1`, {
        headers: u.bearer(),
        timeoutMs: 3000,
      });
      if (resp.http === "200") {
        try {
          fs.writeFileSync(idx, u.remoteTitleIndex(resp.body));
        } catch {}
      }
    }
    try {
      index = fs.readFileSync(idx, "utf8");
    } catch {}
  } else {
    index = u.localTitleIndex(nodes);
  }

  const tplFile = path.join(u.ROOT, "prompts", "client", "nudge.md");
  if (!fs.existsSync(tplFile)) return null;
  const tplSha = u.sha256Head(tplFile);
  const prompt = u.fillTemplate(u.stripTrailingNewlines(fs.readFileSync(tplFile, "utf8")), {
    SLUG: slug,
    FILE: file,
    INDEX: index,
    CONTENT: content,
  });

  // Record to journal/llm-calls (same shape as distill) for the nightly
  // review loop. Best-effort.
  const llmDir = path.join(graph, "journal", "llm-calls");
  const t0 = Date.now();
  let backend = "";
  const recordLlm = (response, error) => {
    if (!u.ensureDir(llmDir)) return;
    const rec = {
      id: `llm-${Date.now()}-${u.bashRandom()}`,
      ts: u.isoMs(),
      source: "nudge",
      backend,
      template: "nudge.md",
      template_sha: tplSha,
      session,
      project: slug,
      latency_ms: Date.now() - t0,
      prompt,
      vars: { SLUG: slug, FILE: file, INDEX: index, CONTENT: content },
      response: error === "" ? response : null,
      error: error === "" ? null : error,
    };
    u.appendLine(path.join(llmDir, `${u.localDate()}.jsonl`), JSON.stringify(rec));
  };

  let response;
  const nudgeCmd = u.cfgStr("nudge.cmd", "NUDGE_CMD");
  if (nudgeCmd) {
    backend = `cmd:${nudgeCmd}`;
    response = u.runBackendCmd(nudgeCmd, prompt);
    if (response === null) {
      recordLlm("", "nudge cmd failed");
      u.appendLine(state, `0\t${file}`);
      return null;
    }
  } else {
    backend = "cli:claude -p --model haiku";
    response = u.runClaudeBackend(prompt);
    if (response === null) {
      recordLlm("", "claude -p failed");
      u.appendLine(state, `0\t${file}`);
      return null;
    }
  }
  recordLlm(response, "");

  if (response.includes("NOTHING")) {
    u.appendLine(state, `0\t${file}`);
    return null;
  }

  const facts = parseFactList(response);
  const nfacts = facts.split("\n").filter((l) => /^[0-9]/.test(l)).length;
  u.appendLine(state, `${nfacts}\t${file}`);
  if (nfacts < 1) return null;

  // Journal the fired nudge so lib/capture-metrics.js can correlate
  // nudges -> subsequent captures.
  u.appendLine(
    path.join(graph, "journal", `${session}.jsonl`),
    JSON.stringify({ ts: u.jqNow(), project: slug, tool: "nudge", file, facts: nfacts })
  );

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: NUDGE_CTX(file, u.stripTrailingNewlines(facts)),
    },
  };
}

async function postTool(input) {
  const graph = u.graphHome();
  const remote = Boolean(u.serverBase());
  // Same gate as distill: in local mode the graph dir must exist.
  if (!remote && !fs.existsSync(path.join(graph, "nodes"))) return null;

  const cwd = input.cwd ?? "";
  const session = input.session_id ?? "unknown";
  const file = input.tool_input?.file_path ?? "";
  const cmd = input.tool_input?.command ?? "";
  const slug = u.projectSlug(cwd);

  u.ensureDir(path.join(graph, "journal"));
  const journal = path.join(graph, "journal", `${session}.jsonl`);

  // File-touch journaling (tool calls with no file path fall through to
  // commit detection).
  if (file) {
    u.appendLine(
      journal,
      JSON.stringify({
        ts: u.jqNow(),
        project: slug,
        tool: input.tool_name ?? null,
        file: input.tool_input?.file_path ?? null,
      })
    );
    return (await nudge({ input, graph, slug, session, file, remote }).catch(() => null)) ?? null;
  }

  // Commit detection: loose textual screen; the 60s freshness guard decides.
  if (!/git[\s\S]*commit/.test(cmd)) return null;
  const top = u.git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!top) return null;
  const now = Math.floor(Date.now() / 1000);
  const log = u.git(top, ["log", "-20", "--format=%H %ct"]) || "";
  let fresh = false;
  for (const line of log.split("\n")) {
    const [sha, ct] = line.split(" ");
    if (!sha) continue;
    if (now - (Number(ct) || 0) > 60) continue;
    fresh = true;
    const nids = trailerNodeIds(top, sha);
    u.appendLine(
      journal,
      JSON.stringify({ ts: u.jqNow(), project: slug, tool: "git-commit", sha, nodes: nids })
    );
  }
  if (!fresh) return null;

  // Stamp trailered commits onto their nodes (remote mode; idempotent).
  await linkCommits(top).catch(() => {});
  return null;
}

module.exports = { postTool, parseFactList };
