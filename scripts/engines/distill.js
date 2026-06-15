"use strict";
// SessionEnd engine (async): distill the session transcript into Spor
// nodes. Node port of distill.sh — LOCAL mode writes nodes, normalizes edge
// variants (pure string ops replace the BSD-incompatible sed -i), validates,
// and commits the graph repo; REMOTE mode is the capture client (QUEUE.md
// §2.3). The transcript NEVER leaves the client in either mode.
//
// Recursion guard: the headless backend call would fire its own SessionEnd
// hook on exit; SPOR_DISTILLING (or legacy SUBSTRATE_DISTILLING) short-circuits that. NEVER remove it.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const u = require("./util");
const { drainOutbox } = require("./drain-outbox");
const { inferCommits } = require("./infer-commits");

// Claude transcript shape: per-JSONL-line `select(.type=="user" or
// .type=="assistant") | .type + ": " + <content text>`.
function claudeConvo(docs) {
  const out = [];
  for (const doc of docs) {
    if (!doc || (doc.type !== "user" && doc.type !== "assistant")) continue;
    const content = doc.message?.content;
    let text;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c) => c && c.type === "text")
        .map((c) => c.text)
        .join("\n");
    } else {
      continue; // jq would error on other shapes; suppressed by 2>/dev/null
    }
    out.push(`${doc.type}: ${text}`);
  }
  return out.join("\n");
}

// Edge-type variants the distiller model is prone to; sed replaced the first
// occurrence per line.
const EDGE_FIXES = [
  ["{type: related-to,", "{type: relates-to,"],
  ["{type: derives-from,", "{type: derived-from,"],
  ["{type: supercedes,", "{type: supersedes,"],
];
function normalizeEdges(text) {
  return text
    .split("\n")
    .map((line) => {
      for (const [from, to] of EDGE_FIXES) {
        const i = line.indexOf(from);
        if (i !== -1) line = line.slice(0, i) + to + line.slice(i + from.length);
      }
      return line;
    })
    .join("\n");
}

// ===NODE <file>=== ... ===END=== blocks.
function parseNodeBlocks(response) {
  const blocks = [];
  let file = "";
  let emit = false;
  let content = "";
  for (const line of String(response).split("\n")) {
    const m = line.match(/^===NODE (.*)===$/);
    if (m) {
      file = m[1].replace(/===$/, "");
      emit = true;
      content = "";
      continue;
    }
    if (line === "===END===") {
      if (emit && file !== "") blocks.push({ file, content });
      emit = false;
      file = "";
      continue;
    }
    if (emit) content += line + "\n";
  }
  return blocks;
}

// ===FACT=== ... ===END=== blocks (content preserves inner newlines).
function parseFactBlocks(response) {
  const facts = [];
  let emit = false;
  let content = "";
  for (const line of String(response).split("\n")) {
    if (line === "===FACT===") {
      emit = true;
      content = "";
      continue;
    }
    if (line === "===END===") {
      if (emit && content !== "") facts.push(content);
      emit = false;
      continue;
    }
    if (emit) content += line + "\n";
  }
  return facts;
}

async function distill(input) {
  if (process.env.SPOR_DISTILLING || process.env.SUBSTRATE_DISTILLING) return null;
  // User kill switch, symmetric with the nudge's SPOR_NUDGE=0 (post-tool.js):
  // SPOR_DISTILL=0 (env) or distill.enabled:false (config) disables the paid
  // SessionEnd distill call. No active config falls back to the exact env
  // dual-read, so unset behavior is byte-identical (default "1").
  if (u.config() ? !u.config().getBool("distill.enabled", true) : (u.envDual("DISTILL") ?? "1") === "0") return null;

  const graph = u.graphHome();
  const nodes = path.join(graph, "nodes");
  const remote = Boolean(u.serverBase());
  if (!remote && !fs.existsSync(nodes)) return null;

  const cwd = input.cwd ?? "";
  const session = input.session_id ?? "unknown";
  const transcriptPath = input.transcript_path ?? "";
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const slug = u.projectSlug(cwd);

  u.ensureDir(path.join(graph, "journal"));
  const logFile = path.join(graph, "journal", "distill.log");
  const log = u.makeLogger(logFile, `${session}: `);
  const rlog = u.makeLogger(path.join(graph, "journal", "remote.log"), `distill ${slug}: `);

  // In remote mode, drain any previously-spooled outbox payloads first.
  if (remote) await drainOutbox(graph, "distill").catch(() => {});

  // Conversation text (last ~24k chars), roles prefixed; generic .text
  // fallback for non-Claude transcript shapes.
  let raw = "";
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  // jq -r emits a trailing newline; tail -c counts that byte; $() strips it.
  const tailStrip = (s) => u.stripTrailingNewlines(u.byteTail(s ? s + "\n" : "", 24000));
  const docs = u.parseJsonStream(raw);
  let convo = tailStrip(claudeConvo(docs));
  if (u.wordCount(convo) < 80) {
    convo = tailStrip(u.collectTextFields(docs).join("\n"));
  }
  if (u.wordCount(convo) < 80) {
    log("skipped: transcript too small");
    return null;
  }

  // Files this session touched (jq -r '.file' | sort -u | head -30 — lines
  // without a file render as "null", exactly as jq -r did).
  let touched = "";
  try {
    const vals = fs
      .readFileSync(path.join(graph, "journal", `${session}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          const v = JSON.parse(l).file;
          return v === undefined || v === null ? "null" : String(v);
        } catch {
          return null;
        }
      })
      .filter((v) => v !== null);
    touched = [...new Set(vals)].sort().slice(0, 30).join("\n");
  } catch {}

  // Graph index: locally from node files, remotely from /v1/status?titles=1.
  let index = "";
  if (remote) {
    const resp = await u.curl(`${u.serverBase()}/v1/status?titles=1`, {
      headers: u.bearer(),
      timeoutMs: 6000,
    });
    if (resp.http === "200") {
      index = u.remoteTitleIndex(resp.body);
      rlog(`index fetched (http=${resp.http})`);
    } else {
      rlog(`index fetch failed (http=${resp.http}); distilling against empty index`);
    }
  } else {
    index = u.localTitleIndex(nodes);
  }

  const date = u.localDate();
  const tplName = remote ? "distill-remote.md" : "distill-local.md";
  const source = remote ? "distill-remote" : "distill-local";
  const tplFile = path.join(u.ROOT, "prompts", "client", tplName);
  if (!fs.existsSync(tplFile)) {
    log(`missing prompt template ${tplFile}`);
    return null;
  }
  const tplSha = u.sha256Head(tplFile);
  if (!touched) touched = "none";
  // PROMPT=$(cat "$TPL_FILE") — strips the template's trailing newline.
  const prompt = u.fillTemplate(u.stripTrailingNewlines(fs.readFileSync(tplFile, "utf8")), {
    SLUG: slug,
    DATE: date,
    INDEX: index,
    TOUCHED: touched,
    CONVO: convo,
  });

  // Record the full prompt/response to journal/llm-calls (template-versioned,
  // eval-replayable). Best-effort: recording failures never block.
  const llmDir = path.join(graph, "journal", "llm-calls");
  const t0 = Date.now();
  let backend = "";
  // Token usage / cost when the backend reports it (the default claude -p JSON
  // path does; SPOR_DISTILL_CMD backends cannot over the stdin->stdout text
  // contract, so they stay null) — task-cc-spor-client-spend-visibility.
  let usage = null;
  let cost_usd = null;
  let model = null;
  const recordLlm = (response, error) => {
    if (!u.ensureDir(llmDir)) return;
    const rec = {
      id: `llm-${Date.now()}-${u.bashRandom()}`,
      ts: u.isoMs(),
      source,
      backend,
      template: tplName,
      template_sha: tplSha,
      session,
      project: slug,
      latency_ms: Date.now() - t0,
      usage,
      cost_usd,
      model,
      prompt,
      vars: { SLUG: slug, DATE: date, INDEX: index, TOUCHED: touched, CONVO: convo },
      response: error === "" ? response : null,
      error: error === "" ? null : error,
    };
    u.appendLine(path.join(llmDir, `${u.localDate()}.jsonl`), JSON.stringify(rec));
  };

  let response;
  const distillCmd = u.cfgStr("distill.cmd", "DISTILL_CMD");
  if (distillCmd) {
    backend = `cmd:${distillCmd}`;
    response = u.runBackendCmd(distillCmd, prompt);
    if (response === null) {
      recordLlm("", "distill cmd failed");
      log("distill cmd failed");
      return null;
    }
  } else {
    backend = "cli:claude -p --model haiku";
    const res = u.runClaudeBackend(prompt);
    if (res === null) {
      recordLlm("", "claude -p failed");
      log("claude -p failed");
      return null;
    }
    response = res.text;
    usage = res.usage;
    cost_usd = res.cost_usd;
    model = res.model;
  }
  recordLlm(response, "");

  // Report the sweep to the server (remote mode), zero-fact sweeps included.
  // Counts only; the transcript stays client-side. Best-effort.
  const reportSweep = async (f, c, sp, r) => {
    if (!remote) return;
    await u.curl(`${u.serverBase()}/v1/distill/report`, {
      method: "POST",
      headers: { ...u.bearer(), "Content-Type": "application/json" },
      body: JSON.stringify({ project: slug, session, facts: f, captured: c, spooled: sp, rejected: r }),
      timeoutMs: 6000,
    }).catch(() => {});
  };

  if (response.includes("NOTHING")) {
    await reportSweep(0, 0, 0, 0);
    log("distilled: nothing durable");
    return null;
  }

  // ---------------------------------------------------------------------------
  // REMOTE MODE: each found fact -> POST /v1/capture; transport failures spool
  // to outbox/*.capture.json; permanent rejects are dropped with a log line.
  // ---------------------------------------------------------------------------
  if (remote) {
    const facts = parseFactBlocks(response);
    if (facts.length < 1) {
      await reportSweep(0, 0, 0, 0);
      log("distilled: no parseable facts");
      return null;
    }
    let sent = 0;
    let spooled = 0;
    let rejected = 0;
    let factNo = 0;
    for (const fact of facts) {
      factNo++;
      // /v1/capture caps text at 4000 chars; truncate defensively.
      const body = JSON.stringify({
        text: u.byteHead(fact, 3900),
        context: { project: slug },
        source: "distill",
      });
      const { http } = await u.curl(`${u.serverBase()}/v1/capture`, {
        method: "POST",
        headers: { ...u.bearer(), "Content-Type": "application/json" },
        body,
        timeoutMs: 90000,
      });
      if (http === "200") {
        sent++;
      } else if (http === "400" || http === "413" || http === "422") {
        rejected++;
        rlog(`capture rejected (http=${http}) for fact-${factNo}.txt`);
      } else {
        u.ensureDir(path.join(graph, "outbox"));
        const spool = path.join(
          graph,
          "outbox",
          `${session}-${Math.floor(Date.now() / 1000)}-${spooled}.capture.json`
        );
        try {
          fs.writeFileSync(spool, body);
        } catch {}
        spooled++;
      }
    }
    await reportSweep(facts.length, sent, spooled, rejected);
    log(`remote distill complete (${facts.length} facts: ${sent} captured, ${spooled} spooled, ${rejected} rejected)`);
    rlog(`captured ${sent}/${facts.length} facts (${spooled} spooled, ${rejected} rejected)`);

    // Infer commit→node links for this session's UNTRAILERED commits
    // (task-cc-commit-inference). Fail-open; never affects the distill above.
    await inferCommits({
      repo: cwd,
      journal: path.join(graph, "journal", `${session}.jsonl`),
      index,
      slug,
      session,
    }).catch(() => {});
    return null;
  }

  // ---------------------------------------------------------------------------
  // LOCAL MODE (original behavior — byte-identical node writes)
  // ---------------------------------------------------------------------------
  const written = [];
  for (const block of parseNodeBlocks(response)) {
    const file = path.join(nodes, block.file);
    if (fs.existsSync(file)) {
      u.appendLine(logFile, `  skip-existing ${file}`);
      continue;
    }
    try {
      fs.writeFileSync(file, normalizeEdges(block.content));
      u.appendLine(logFile, `  wrote ${file}`);
      written.push(file);
    } catch {}
  }
  const candidates = String(response)
    .split("\n")
    .filter((l) => l.startsWith("===NODE")).length;
  log(`distill complete (${candidates} candidate nodes)`);

  // Lint what we just wrote; problems are logged, not fatal.
  const v = spawnSync(process.execPath, [path.join(u.ROOT, "lib", "validate.js"), "--nodes", nodes], {
    encoding: "utf8",
  });
  try {
    fs.appendFileSync(logFile, (v.stdout || "") + (v.stderr || ""));
  } catch {}
  if (v.status !== 0 || v.error) log(`validation found errors — review ${nodes}`);

  // Commit the graph if it's a git repo.
  if (fs.existsSync(path.join(graph, ".git")) && written.length > 0) {
    const add = u.git(graph, ["add", "nodes/"]);
    const commit =
      add !== null ? u.git(graph, ["commit", "-qm", `distill: session ${session} (${slug})`]) : null;
    if (add === null || commit === null) log("graph commit failed");
  }
  return null;
}

module.exports = { distill, normalizeEdges, parseNodeBlocks, parseFactBlocks };
