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
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const u = require("./util");
const { drainOutbox } = require("./drain-outbox");
const { inferCommits } = require("./infer-commits");
const resolutionLib = require(path.join(u.ROOT, "lib", "kernel", "resolution.js"));

// The nested-repo guard (graph home === code repo) now lives in util so the
// `spor init` path can share it (task-spor-onboard-cli-init-git-identity).
const { graphInsideCodeRepo } = u;

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

// task-cc-client-sessionend-reserve-hook (dec-cc-task-resumption-reservation):
// the fifth-and-sixth lease actions, called from SessionEnd. Converts every
// task THIS SESSION held a live Tier-1 lease on — evidenced by its own
// claim-heartbeat journal lines, the no-LLM per-write renewal the post-tool
// claim-nudge branch already performs (task-cc-claim-nudge-hook) — into
// whichever half of the two-tier lease model fits: still open -> an
// owner-exclusive resumption reservation (`reserve`, advanced but unfinished);
// gone terminal or closed by a resolver edge -> `release` (drop the lease and
// the durable `assigned` edge, cleaning up after finished work). A task this
// session never actually renewed (no edit landed while its lease was live) is
// left alone entirely — "does nothing when no claim was held" — so its Tier-1
// lease just expires on its own TTL rather than being touched by a session
// that did no real work on it.
//
// Scoping to THIS session's own heartbeat record — not a fresh person-scoped
// `assignee=me` queue read — is deliberate: a finished task drops out of the
// queue entirely (rankQueue only ever lists LIVE nodes, even in the steward
// view), so that endpoint can't see a task that just went terminal; and a
// person-scoped read would risk acting on a claim a DIFFERENT concurrent
// session of the same person is still actively working. The session's own
// journal has neither problem.
//
// Same gating posture as the post-tool claim-nudge branch: remote/team mode
// only, in a real git repo, fail-open, config-cascade knobs
// (sessionLease.enabled / SPOR_SESSION_LEASE, default on). No LLM.
async function sessionEndLease({ graph, slug, session, cwd, remote }) {
  if (!remote) return; // a lease is meaningless without a shared server
  if (u.config() ? !u.config().getBool("sessionLease.enabled", true) : (u.envDual("SESSION_LEASE") ?? "1") === "0")
    return;
  const top = u.git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top || !top.trim()) return; // no repo root -> no project pool to act on

  const journalPath = path.join(graph, "journal", `${session}.jsonl`);
  let entries = [];
  try {
    entries = fs
      .readFileSync(journalPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return; // no journal for this session -> no heartbeats -> nothing held
  }
  const ids = new Set();
  for (const e of entries) {
    if (e.tool === "claim-heartbeat" && Array.isArray(e.renewed)) {
      for (const id of e.renewed) if (id) ids.add(id);
    }
  }
  if (ids.size === 0) return; // no claim held this session

  const timeoutMs = u.cfgNum("sessionLease.timeoutMs", "SESSION_LEASE_TIMEOUT", 3000);
  // Each id's GET+POST is independent, so run them concurrently rather than
  // paying up to N * 2 * timeoutMs sequentially for a session that held
  // several claims.
  const convert = async (id) => {
    const get = await u
      .curl(`${u.serverBase()}/v1/nodes/${encodeURIComponent(id)}`, { headers: u.bearer(), timeoutMs })
      .catch(() => null);
    if (!get || get.http !== "200") return; // can't verify -> leave the lease alone
    let parsed;
    try {
      parsed = JSON.parse(get.body);
    } catch {
      return;
    }
    if (typeof parsed.raw !== "string") return;
    const status = parsed.raw
      .split("\n")
      .find((l) => l.startsWith("status:"))
      ?.slice(7)
      .trim() ?? "";
    // Status lags resolution edges (issue-cc-status-lags-resolution-edges):
    // the `resolution` read-time enrichment (a live inbound resolves/answers
    // edge) means the task is done even while its status field still reads
    // open, so either signal counts as finished.
    const finished = Boolean(parsed.resolution) || resolutionLib.isTerminalStatus(status);
    const action = finished ? "release" : "reserve";
    const body = action === "reserve" ? JSON.stringify({ session }) : "{}";
    const post = await u
      .curl(`${u.serverBase()}/v1/nodes/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        headers: { ...u.bearer(), "content-type": "application/json" },
        body,
        timeoutMs,
      })
      .catch(() => null);
    u.appendLine(
      journalPath,
      JSON.stringify({ ts: u.jqNow(), project: slug, tool: "session-lease", id, action, http: post ? post.http : "000" })
    );
  };
  await Promise.all([...ids].map(convert));
}

async function distill(input) {
  if (process.env.SPOR_DISTILLING || process.env.SUBSTRATE_DISTILLING) return null;

  const graph = u.graphHome();
  const remote = Boolean(u.serverBase());
  const cwd = input.cwd ?? "";
  const session = input.session_id ?? "unknown";
  const slug = u.projectSlug(cwd);

  // task-cc-client-sessionend-reserve-hook: independent of the LLM
  // distillation below (no-LLM, its own gates) so a disabled/failing
  // distiller never blocks the lease conversion, and vice versa. Skipped for
  // a debounce-approximated firing (spor_debounced, set by bin/spor-hook.js
  // when spooling for Codex/Copilot/OpenCode's turn-scoped quiescence) — that
  // is NOT a genuine session-end signal, and a mid-session pause trips it just
  // as easily as a real goodbye, so acting on it risks silently reserving or
  // releasing a claim that is still actively being worked.
  if (!input.spor_debounced) {
    await sessionEndLease({ graph, slug, session, cwd, remote }).catch(() => {});
  }

  // User kill switch, symmetric with the nudge's SPOR_NUDGE=0 (post-tool.js):
  // SPOR_DISTILL=0 (env) or distill.enabled:false (config) disables the paid
  // SessionEnd distill call. No active config falls back to the exact env
  // dual-read, so unset behavior is byte-identical (default "1").
  if (u.config() ? !u.config().getBool("distill.enabled", true) : (u.envDual("DISTILL") ?? "1") === "0") return null;

  const nodes = path.join(graph, "nodes");
  if (!remote && !fs.existsSync(nodes)) return null;

  const transcriptPath = input.transcript_path ?? "";
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

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
  // Bound a hung distill backend (distill.timeoutMs / SPOR_DISTILL_TIMEOUT,
  // default 120s — generous: the distill processes a ~24k-char transcript and
  // runs async on SessionEnd, so it tolerates more than the nudge, but a wedged
  // CLI should still not hang the SessionEnd hook indefinitely).
  const timeoutMs = u.cfgNum("distill.timeoutMs", "DISTILL_TIMEOUT", 120000);
  const distillCmd = u.cfgStr("distill.cmd", "DISTILL_CMD") || u.hostDefaultBackendCmd("distill");
  if (distillCmd) {
    backend = `cmd:${distillCmd}`;
    response = u.runBackendCmd(distillCmd, prompt, { timeoutMs });
    if (response === null) {
      recordLlm("", "distill cmd failed");
      log("distill cmd failed");
      return null;
    }
  } else {
    backend = "cli:claude -p --model haiku";
    const res = u.runClaudeBackend(prompt, { timeoutMs });
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
      // /v1/capture caps text at 4000 chars; truncate defensively. The per-fact
      // idempotency key is a deterministic hash(session, fact) — the key the
      // server contract prescribes for live distill POSTs (spor-server
      // capture.js / rest.js POST /v1/capture). It closes the
      // timeout-then-server-completes race the `spor add` path guards
      // (issue-spor-add-cli-duplicate-on-timeout-drain): a fact that spools
      // (below) on an aborted-but-landed POST re-ships the SAME key on drain, so
      // the server dedupes instead of ingesting a second node. Hashing on
      // (session, text) rather than a random UUID ALSO coalesces a re-distill of
      // the SAME session across separate runs
      // (task-spor-distiller-idempotency-deterministic-hash) — defense-in-depth
      // behind the SPOR_DISTILLING recursion guard, the only thing preventing
      // that re-run today.
      const text = u.byteHead(fact, 3900);
      const body = JSON.stringify({
        text,
        context: { project: slug },
        source: "distill",
        idempotency_key: crypto.createHash("sha256").update(`${session}\n${text}`).digest("hex"),
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

  // Commit the graph if it's a git repo — UNLESS the graph home lives inside the
  // session's own code repo (the nested-repo hazard, graphInsideCodeRepo). In a
  // per-repo `graph:` sharing setup pointed at the code repo, auto-committing
  // would land distiller commits on the code branch; instead leave the nodes as
  // working-tree changes for the contributor's PR (dec-spor-local-mode-sharing-
  // boundary: distilled nodes ride the normal PR flow).
  if (fs.existsSync(path.join(graph, ".git")) && written.length > 0) {
    if (graphInsideCodeRepo(graph, cwd)) {
      log(
        `graph home is inside the session repo — leaving ${written.length} distilled node(s) uncommitted for the PR flow (dec-spor-local-mode-sharing-boundary)`
      );
    } else {
      const add = u.git(graph, ["add", "nodes/"]);
      const commit =
        add !== null ? u.git(graph, [...u.NO_GPGSIGN, "commit", "-qm", `distill: session ${session} (${slug})`]) : null;
      if (add === null || commit === null) log("graph commit failed");
    }
  }
  return null;
}

module.exports = { distill, normalizeEdges, parseNodeBlocks, parseFactBlocks, graphInsideCodeRepo, sessionEndLease };
