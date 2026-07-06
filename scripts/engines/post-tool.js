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
const coupling = require(path.join(u.ROOT, "lib", "kernel", "coupling.js"));

const NUDGE_CTX = (file, facts) =>
  `[spor capture nudge] The file you just wrote (${file}) contains findings that do not appear to be in the team graph:

${facts}

If a finding is durable, capture it NOW — one /spor:defer (or capture tool) call per finding, in your own words with full context. If none are durable, dismiss this consciously and move on. Live capture beats the session-end backstop: you still have the context the distiller won't. (Classifier: source=nudge; disable with SPOR_NUDGE=0.)`;

// task-cc-claim-nudge-hook (dec-cc-task-claim-lease): the static, no-LLM
// claim nudge injected when you edit a team-mode repo holding no live claim.
// Offers (never auto-claims) the top eligible items in this project, plus
// /spor:defer for work that isn't a node yet.
const CLAIM_NUDGE_CTX = (slug, items) =>
  `[spor claim nudge] You're editing ${slug} with no task claimed. On a shared project, claiming collapses a task to one owner so teammates don't duplicate your work; the claim is a heartbeat-renewed lease that returns to the pool if you stall.

Top eligible work here:
${items}

Claim one with /spor:next (or set its status to in_progress), or file the work you're doing now with /spor:defer if it isn't a task yet. (source=claim-nudge; once per session; disable with SPOR_CLAIM_NUDGE=0.)`;

// task-spor-coupling-nudge-posttool (dec-spor-coupling-norms-declared-first):
// the edit-time coupling nudge, injected when the edited path matches a
// declared coupling norm's trigger globs. Names the coupled artifacts while
// the agent still holds the context of the change.
const COUPLING_NUDGE_CTX = (rel, lines) =>
  `[spor coupling nudge] You edited ${rel} — coupling norms in the team graph say these artifacts change together:

${lines}

Update the coupled artifacts in this same change, or consciously dismiss with a reason. A target written <repo>:<path> lives in that other repo. (source=coupling-nudge; once per session per norm; disable with SPOR_COUPLING_NUDGE=0.)`;

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
  const norm = (p) => path.resolve(String(p || "")).replace(/\\/g, "/").toLowerCase();
  const nfile = norm(file);
  // Auto-memory carve-out (issue-spor-capture-nudge-memory-exclusion-loses-
  // facts): ~/.claude is excluded as agent-private, but its memory files
  // (~/.claude/projects/<proj>/memory/*.md) are exactly where durable findings
  // land INSTEAD of the graph — the 1,120-session retrospective found memory
  // acting as a graph substitute (0–10% unprompted capture vs 72% when
  // graph-scoped). A memory write is a signal the agent judged something
  // durable, so it routes through the classifier like any other prose .md;
  // the MEMORY.md index (one-line pointers, no facts) still drops via the
  // instruction-file basename list below.
  const isMemory = nfile.startsWith(norm(path.join(home, ".claude")) + "/") && /\/memory\/[^/]+\.md$/.test(nfile);
  if (
    nfile.startsWith(norm(graph) + "/") ||
    (nfile.startsWith(norm(path.join(home, ".claude")) + "/") && !isMemory) ||
    nfile.includes("/nodes/")
  )
    return null; // graph homes + agent-private config (memory files excepted)
  const base = path.basename(file);
  if (["CLAUDE.md", "AGENTS.md", "GEMINI.md", "MEMORY.md"].includes(base)) return null;
  const tool = input.tool_name ?? "";
  if (!["Write", "Edit", "write", "edit"].includes(tool)) return null;
  // jq -r adds a trailing newline; head -c counts it; $() strips it.
  const rawContent = input.tool_input?.content ?? input.tool_input?.new_string ?? "";
  const content = u.stripTrailingNewlines(u.byteHead(rawContent ? rawContent + "\n" : "", 8000));
  if (u.wordCount(content) < 50) return null; // substantial prose only

  // Cooldown: classify each file at most once per session; at most 3 FIRED
  // nudges per session; and a per-session ceiling on TOTAL classifier calls
  // (nudge.maxCalls / SPOR_NUDGE_MAX, default 20). State lines are
  // "<facts>\t<file>" — one per file, written for every outcome including
  // NOTHING and backend failure, so the line count is exactly the number of
  // classifier calls made this session. The fired cap (≥3) bounds INJECTED
  // nudges; the total cap bounds spend/latency in a docs-heavy session where
  // many .md files each classify to NOTHING (a "0\t" line is free against the
  // fired cap but still cost a paid call) — task-cc-spor-nudge-productization.
  const state = path.join(graph, "journal", `${session}.nudged`);
  let stateLines = [];
  try {
    stateLines = fs.readFileSync(state, "utf8").split("\n").filter(Boolean);
  } catch {}
  if (stateLines.some((l) => l.split("\t").slice(1).join("\t") === file)) return null;
  if (stateLines.filter((l) => Number(l.split("\t")[0]) > 0).length >= 3) return null;
  const maxCalls = u.cfgNum("nudge.maxCalls", "NUDGE_MAX", 20);
  if (stateLines.length >= maxCalls) return null;

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
  // Token usage / cost when the backend reports it (default claude -p JSON
  // path; SPOR_NUDGE_CMD backends stay null) —
  // task-cc-spor-client-spend-visibility.
  let usage = null;
  let cost_usd = null;
  let model = null;
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
      usage,
      cost_usd,
      model,
      prompt,
      vars: { SLUG: slug, FILE: file, INDEX: index, CONTENT: content },
      response: error === "" ? response : null,
      error: error === "" ? null : error,
    };
    u.appendLine(path.join(llmDir, `${u.localDate()}.jsonl`), JSON.stringify(rec));
  };

  let response;
  // Bound a hung backend so the nudge can't block the tool loop past the host's
  // PostToolUse budget (nudge.timeoutMs / SPOR_NUDGE_TIMEOUT, default 30s — room
  // for a ~17s claude -p haiku cold boot, well under the host's 60s).
  const timeoutMs = u.cfgNum("nudge.timeoutMs", "NUDGE_TIMEOUT", 30000);
  const nudgeCmd = u.cfgStr("nudge.cmd", "NUDGE_CMD") || u.hostDefaultBackendCmd("nudge");
  if (nudgeCmd) {
    backend = `cmd:${nudgeCmd}`;
    response = u.runBackendCmd(nudgeCmd, prompt, { timeoutMs });
    if (response === null) {
      recordLlm("", "nudge cmd failed");
      u.appendLine(state, `0\t${file}`);
      return null;
    }
  } else {
    backend = "cli:claude -p --model haiku";
    const res = u.runClaudeBackend(prompt, { timeoutMs });
    if (res === null) {
      recordLlm("", "claude -p failed");
      u.appendLine(state, `0\t${file}`);
      return null;
    }
    response = res.text;
    usage = res.usage;
    cost_usd = res.cost_usd;
    model = res.model;
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

// task-cc-claim-nudge-hook — the unified post-tool claim branch
// (dec-cc-task-claim-lease). On every Write/Edit in a team-mode repo it does
// ONE no-LLM boolean lease lookup (a queue read, not a classifier — stays off
// the LLM path) and branches:
//   - this PERSON holds a live (Tier-1) claim in this project -> renew each one
//     (the heartbeat; piggybacks on the write-activity that already fired the
//     hook, so no new timer — that is what keeps it portable across adapters
//     that don't fire hooks uniformly). Renewing is session-scoped: only the
//     editing session's writes drive it, and the server stamps THIS session as
//     the renewing session. No nudge.
//   - no live claim -> nudge ONCE per session to claim a top eligible item or
//     /spor:defer. Offers, never auto-claims.
//
// The lookup is GET /v1/queue?project=<slug>&assignee=me: with assignee set the
// read is a lease-EXEMPT steward/capacity view (lib/kernel/queue.js), so the
// person's OWN carried work comes back tagged with lease_state/lease_by even
// though those items are hidden from teammates. That single response answers
// both "does this person hold a live claim here?" (person-scoped suppression,
// across ALL their sessions) and "which live (in_progress) leases to renew."
//
// Gating (the capture-nudge lessons): remote/team mode only (a claim is
// meaningless solo); in a real repo only (needs a project slug from a git
// root); person-scoped nudge suppression but session-scoped heartbeat;
// once-per-session cooldown via journal/<session>.claim-nudged; disable with
// SPOR_CLAIM_NUDGE=0 (claimNudge.enabled:false). FAIL-OPEN: any error, or a
// lease state we cannot verify (server down, non-200, unparseable), yields NO
// nudge and exits 0 — never nudge during an outage, never block the tool loop.
async function claimNudge({ graph, slug, session, cwd, remote }) {
  // Remote/team mode only — claims are meaningless without a shared server.
  if (!remote) return null;
  // Disable lever: SPOR_CLAIM_NUDGE=0 / claimNudge.enabled:false. Like the
  // other nudge knobs, resolve through the config cascade, falling back to the
  // exact env dual-read when no config is active (byte-identical standalone).
  if (u.config() ? !u.config().getBool("claimNudge.enabled", true) : (u.envDual("CLAIM_NUDGE") ?? "1") === "0") return null;
  // Headless calls (the distiller's claude -p) don't nudge.
  if (process.env.SPOR_DISTILLING || process.env.SUBSTRATE_DISTILLING) return null;
  // In-repo only: a real git root must back the slug, else this is a loose
  // directory and there is no project pool to claim from. (projectSlug falls
  // back to the cwd basename for a non-repo; the claim model is repo-scoped.)
  const top = u.git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top || !top.trim()) return null;

  // The one no-LLM lookup: the viewer's own carried work in this project. The
  // bound (claimNudge.timeoutMs / SPOR_CLAIM_NUDGE_TIMEOUT, default 3s) keeps
  // the curl well under the host's PostToolUse budget; a dead/slow server
  // returns http "000" and we fail open.
  const timeoutMs = u.cfgNum("claimNudge.timeoutMs", "CLAIM_NUDGE_TIMEOUT", 3000);
  const mine = await u.curl(`${u.serverBase()}/v1/queue?project=${encodeURIComponent(slug)}&assignee=me`, {
    headers: u.bearer(),
    timeoutMs,
  });
  if (mine.http !== "200") return null; // can't verify -> never nudge (fail-open)
  let myItems;
  try {
    myItems = JSON.parse(mine.body).items;
  } catch {
    return null;
  }
  if (!Array.isArray(myItems)) return null;

  // Person-scoped suppression: any item the person holds (live Tier-1
  // in_progress OR Tier-2 reserved) means they have a claim in this project
  // from SOME session — suppress the nudge entirely (kills the multi-session
  // false positive). Session-scoped heartbeat: renew the LIVE (in_progress)
  // ones; the editing session's write activity drives the heartbeat and the
  // server records this session as the renewing one. A Tier-2 reservation is
  // owner-exclusive but NOT heartbeated, so it suppresses without renewing.
  const held = myItems.filter((i) => i && i.lease_state && i.id);
  if (held.length > 0) {
    for (const i of held.filter((x) => x.lease_state === "in_progress")) {
      await u.curl(`${u.serverBase()}/v1/nodes/${encodeURIComponent(i.id)}/renew`, {
        method: "POST",
        headers: { ...u.bearer(), "content-type": "application/json" },
        body: JSON.stringify({ session }),
        timeoutMs,
      }).catch(() => null);
    }
    // Journal the heartbeat so the operability log can correlate write-activity
    // to renewals; best-effort.
    u.appendLine(
      path.join(graph, "journal", `${session}.jsonl`),
      JSON.stringify({ ts: u.jqNow(), project: slug, tool: "claim-heartbeat", renewed: held.filter((x) => x.lease_state === "in_progress").map((x) => x.id) })
    );
    return null; // holds a claim -> never nudge
  }

  // No live claim. Once-per-session cooldown (mirrors journal/<session>.nudged):
  // nudge at most once per session, not on every write.
  const state = path.join(graph, "journal", `${session}.claim-nudged`);
  if (fs.existsSync(state)) return null;

  // Top eligible items to offer. The full project pool (NOT assignee-scoped, so
  // teammates' live claims are correctly hidden) — the items anyone here can
  // grab. Empty pool -> nothing worth nudging about; stay silent.
  const pool = await u.curl(`${u.serverBase()}/v1/queue?project=${encodeURIComponent(slug)}&limit=3`, {
    headers: u.bearer(),
    timeoutMs,
  });
  if (pool.http !== "200") return null;
  let poolItems;
  try {
    poolItems = JSON.parse(pool.body).items;
  } catch {
    return null;
  }
  if (!Array.isArray(poolItems) || poolItems.length === 0) return null;
  const lines = poolItems
    .slice(0, 3)
    .map((i) => `- ${i.id} — ${i.title || ""}${i.why ? ` (${i.why})` : ""}`)
    .join("\n");
  if (!lines) return null;

  // Mark the cooldown BEFORE returning so a same-session retry stays silent
  // even if the consumer ignores this nudge. Best-effort; an unwritable state
  // file just means a possible second nudge, never a crash.
  u.ensureDir(path.join(graph, "journal"));
  u.appendLine(state, u.jqNow());
  u.appendLine(
    path.join(graph, "journal", `${session}.jsonl`),
    JSON.stringify({ ts: u.jqNow(), project: slug, tool: "claim-nudge", offered: poolItems.slice(0, 3).map((i) => i.id) })
  );

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: CLAIM_NUDGE_CTX(slug, lines),
    },
  };
}

// ---------------------------------------------------------------------------
// task-spor-coupling-nudge-posttool (dec-spor-coupling-norms-declared-first):
// the edit-time COUPLING nudge. When the edited path matches the trigger globs
// (`couples_when`) of a coupling norm in the graph, inject the norm's coupled
// targets (`couples_also`) — the "you changed X, don't forget Y" moment,
// delivered while the agent still holds the context of the change. A pure
// deterministic glob match (lib/kernel/coupling.js): NO LLM ever, and no
// network on the match path — the norms come from the local nodes dir (local
// mode) or a TTL-cached snapshot (remote mode). Once per (session, norm) via
// journal/<session>.coupling-nudged; disable with SPOR_COUPLING_NUDGE=0
// (couplingNudge.enabled:false). Fail-open by contract; a graph with no
// coupling norms yields byte-identical output.

// The norm snapshot both modes read: { norms: [slim coupling norms],
// repo_tags: {slug: [tags]} } — repo tags feed the applies_to_tags scope. The
// scan itself lives in lib/kernel/coupling.js (scanCouplingEntries), shared
// with the `spor check` verb so the two consumers can't drift.
const { scanCouplingEntries } = coupling;

// Local mode: the nodes dir is the graph. Rebuilding on every Write/Edit would
// read every node file, so the snapshot is cached in cache/coupling.json keyed
// by a readdir+mtime fingerprint (the loadGraphCached idea, but durable across
// hook invocations — each hook is its own process). Stale fingerprint =
// rebuild; a fresh graph write (e.g. authoring a coupling norm) is picked up
// on the next tool call, no TTL wait.
function nodesFingerprint(nodesDir) {
  let count = 0;
  let newest = 0;
  for (const f of fs.readdirSync(nodesDir)) {
    if (!f.endsWith(".md")) continue;
    count++;
    const m = fs.statSync(path.join(nodesDir, f)).mtimeMs;
    if (m > newest) newest = m;
  }
  return `${count}:${newest}`;
}

function localCouplingData(graph) {
  const nodesDir = path.join(graph, "nodes");
  let fp;
  try {
    fp = nodesFingerprint(nodesDir);
  } catch {
    return null;
  }
  const cacheFile = path.join(graph, "cache", "coupling.json");
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (c && c.fp === fp) return c;
  } catch {}
  const data = {
    v: 1,
    fp,
    ...scanCouplingEntries((f) => fs.readFileSync(path.join(nodesDir, f), "utf8"), fs.readdirSync(nodesDir).sort()),
  };
  if (u.ensureDir(path.join(graph, "cache"))) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(data));
    } catch {}
  }
  return data;
}

// Remote mode: the graph lives on the server; the snapshot refreshes from the
// documented enumeration surface (GET /v1/export, parsed with lib/tar.js) at
// most once per hour. The `fetched` stamp is written BEFORE the download (the
// agentHeartbeat lesson) so a dead/slow server costs at most ONE bounded
// attempt per TTL — and stale data survives a failed refresh (stale beats
// none, the cached-title-index rule). Delete cache/coupling.json to force a
// refresh. A lighter server read than the full export is deferred work.
const COUPLING_CACHE_TTL_MS = 3600000;
async function remoteCouplingData(graph) {
  const cacheFile = path.join(graph, "cache", "coupling.json");
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } catch {}
  const now = Date.now();
  if (cached && typeof cached.fetched === "number" && now - cached.fetched < COUPLING_CACHE_TTL_MS) return cached;
  const stale = cached && Array.isArray(cached.norms) ? cached : { v: 1, norms: [], repo_tags: {} };
  stale.fetched = now;
  if (u.ensureDir(path.join(graph, "cache"))) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(stale));
    } catch {}
  }
  const timeoutMs = u.cfgNum("couplingNudge.timeoutMs", "COUPLING_NUDGE_TIMEOUT", 3000);
  const remoteLib = require(path.join(u.ROOT, "lib", "remote.js"));
  const tar = require(path.join(u.ROOT, "lib", "tar.js"));
  const r = await remoteLib.download(u.config(), "/v1/export", { timeoutMs }).catch(() => null);
  if (!r || !r.ok || !r.buffer) return stale;
  let entries;
  try {
    entries = tar.extract(r.buffer);
  } catch {
    return stale;
  }
  const byName = new Map(
    entries.filter((e) => e.name.endsWith(".md")).map((e) => [path.basename(e.name), e.data.toString("utf8")])
  );
  const data = { v: 1, fetched: now, ...scanCouplingEntries((f) => byName.get(f), [...byName.keys()].sort()) };
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(data));
  } catch {}
  return data;
}

async function couplingNudge({ input, graph, slug, session, cwd, remote }) {
  if (u.config() ? !u.config().getBool("couplingNudge.enabled", true) : (u.envDual("COUPLING_NUDGE") ?? "1") === "0") return null;
  if (process.env.SPOR_DISTILLING || process.env.SUBSTRATE_DISTILLING) return null; // headless calls don't nudge
  const tool = input.tool_name ?? "";
  if (!["Write", "Edit", "write", "edit"].includes(tool)) return null;
  const file = input.tool_input?.file_path ?? "";
  if (!file) return null;
  // Graph-home writes (node files, journal) are never repo artifacts.
  const npath = (p) => path.resolve(String(p || "")).replace(/\\/g, "/");
  if (npath(file).startsWith(npath(graph) + "/")) return null;
  // Coupling globs are repo-root-relative: resolve the repo top and the
  // edited file's path under it; a write outside any repo can't match.
  const top = u.git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!top) return null;
  // Canonicalize both sides before deriving the repo-relative path: on the
  // windows-latest runner os.tmpdir() is an 8.3 short path (RUNNER~1) while git
  // returns the long form, and the naive path.relative walks clean out of the
  // repo (issue-spor-windows-ci-short-path-mismatch).
  const rel = u.repoRelative(top, file);
  if (!rel) return null;

  const data = remote ? await remoteCouplingData(graph) : localCouplingData(graph);
  if (!data || !Array.isArray(data.norms) || data.norms.length === 0) return null;
  const hits = coupling.matchCouplings(data.norms, {
    slug,
    relPath: rel,
    repoTags: data.repo_tags?.[slug] ?? [],
  });
  if (!hits.length) return null;

  // Once per (session, norm): the cooldown file holds one fired norm id per
  // line, so a norm that already nudged stays silent while a NEW norm hit
  // later in the session still surfaces.
  const state = path.join(graph, "journal", `${session}.coupling-nudged`);
  let fired = [];
  try {
    fired = fs.readFileSync(state, "utf8").split("\n").filter(Boolean);
  } catch {}
  const fresh = hits.filter((n) => !fired.includes(n.id));
  if (!fresh.length) return null;
  u.ensureDir(path.join(graph, "journal"));
  for (const n of fresh) u.appendLine(state, n.id);

  const lines = fresh
    .map((n) => {
      const targets = (Array.isArray(n.couples_also) ? n.couples_also : []).join(", ");
      return `- ${n.id}${n.title ? ` — ${n.title}` : ""}: also update ${targets}`;
    })
    .join("\n");
  u.appendLine(
    path.join(graph, "journal", `${session}.jsonl`),
    JSON.stringify({ ts: u.jqNow(), project: slug, tool: "coupling-nudge", file, norms: fresh.map((n) => n.id) })
  );
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: COUPLING_NUDGE_CTX(rel, lines),
    },
  };
}

// task-spor-fleet-scheduler-client-heartbeat-tick — the mid-session FLEET
// liveness tick. The server's heartbeat endpoint (POST /v1/agents/{id}/heartbeat,
// art-spor-fleet-scheduler-hardening-shipped) refreshes this box's agent
// `last_seen` WITHOUT re-uploading capabilities, and the fleet scheduler keys its
// host-match staleness (?max_age, GET /v1/profiles/{id}/hosts) off `last_seen`.
// Today only session-start refreshes it — the EXPENSIVE way, via a full
// capabilities re-publish (task-spor-fleet-capabilities-autopublish-session-start)
// — so a box that publishes once and then runs for hours ages out of host-matches
// mid-session even though it is alive. This tick keeps last_seen fresh BETWEEN
// session-starts with the cheap "still here" ping.
//
// Like the claim heartbeat above it piggybacks on write-activity (no new timer, so
// it's portable across adapters that don't fire hooks uniformly), but it is
// THROTTLED to one ping per dispatch.heartbeatIntervalMs (default 5min) via a
// per-session cooldown file holding the last-tick epoch (ms) — a held lease must
// renew on every write, but liveness only needs to beat the staleness window. The
// cooldown is stamped BEFORE the curl, so a dead/slow server can't make every
// write pay the (bounded) timeout — at most one attempt per interval. REMOTE mode
// only and only when a `dispatch.agent` is configured (the SAME opt-in as the
// session-start auto-publish: a box that never ran `spor agent use` has no fleet
// identity to keep alive). Fail-open and bounded (dispatch.heartbeatTimeoutMs,
// default 3s, like the publish curl); ALWAYS returns null — a pure side effect,
// never the output envelope. Disable with SPOR_HEARTBEAT=0 (dispatch.heartbeat:
// false). A 404 means caps were never published (publish-before-heartbeat); we
// journal it and fail open — the next session-start auto-publish re-seeds them.
async function agentHeartbeat({ graph, session, remote }) {
  try {
    if (!remote) return null; // local mode: no fleet, no-op (keeps output byte-identical)
    const cfg = u.config();
    if (cfg ? !cfg.getBool("dispatch.heartbeat", true) : (u.envDual("HEARTBEAT") ?? "1") === "0") return null;
    if (process.env.SPOR_DISTILLING || process.env.SUBSTRATE_DISTILLING) return null; // headless calls don't tick
    const agent = cfg ? cfg.get("dispatch.agent", null) : u.envDual("DISPATCH_AGENT") || null;
    if (!agent) return null; // no dispatch identity on this box — nothing to keep alive

    // Throttle: at most one tick per interval, cooldown keyed on the editing
    // session (mirrors journal/<session>.nudged / .claim-nudged). Stamp the
    // last-tick epoch BEFORE the curl so an outage can't make every write pay the
    // bounded timeout.
    const intervalMs = u.cfgNum("dispatch.heartbeatIntervalMs", "HEARTBEAT_INTERVAL", 300000);
    const state = path.join(graph, "journal", `${session}.heartbeat`);
    let last = 0;
    try {
      last = Number(fs.readFileSync(state, "utf8").trim()) || 0;
    } catch {}
    const now = Date.now();
    if (now - last < intervalMs) return null;
    u.ensureDir(path.join(graph, "journal"));
    try {
      fs.writeFileSync(state, String(now));
    } catch {}

    const timeoutMs = u.cfgNum("dispatch.heartbeatTimeoutMs", "HEARTBEAT_TIMEOUT", 3000);
    const r = await u.curl(`${u.serverBase()}/v1/agents/${encodeURIComponent(agent)}/heartbeat`, {
      method: "POST",
      headers: u.bearer(),
      timeoutMs,
    });
    // Journal the tick (best-effort) so the operability log can correlate
    // write-activity to liveness pings.
    u.appendLine(
      path.join(graph, "journal", `${session}.jsonl`),
      JSON.stringify({ ts: u.jqNow(), tool: "agent-heartbeat", agent, http: r ? r.http : "000" })
    );
  } catch {
    /* fail open — the liveness tick must never cost the tool loop */
  }
  return null;
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
    // Fleet liveness heartbeat (task-spor-fleet-scheduler-client-heartbeat-tick):
    // keep this box's agent last_seen fresh mid-session. A throttled, fail-open
    // side effect that always returns null (never the output envelope), so it
    // doesn't compete with the claim/capture nudges below; no-op in local mode.
    await agentHeartbeat({ graph, session, remote }).catch(() => null);
    // Claim heartbeat / nudge (task-cc-claim-nudge-hook) runs FIRST: it's the
    // cheap no-LLM lease lookup, and its nudge (the no-claim branch) takes
    // precedence over the LLM capture nudge for the single output envelope. The
    // heartbeat branch returns null, so a held-claim write still falls through
    // to the nudges below. Both branches no-op in local mode. Fail-open.
    const claim = await claimNudge({ graph, slug, session, cwd, remote }).catch(() => null);
    if (claim) return claim;
    // Coupling nudge (task-spor-coupling-nudge-posttool) runs SECOND: a
    // deterministic declared-coupling hit beats the LLM capture classifier for
    // the envelope (higher precision, zero spend). Taking the envelope here
    // does NOT permanently starve the capture nudge — no `.nudged` state line
    // is written for the file, so its NEXT edit still classifies. Runs in both
    // modes; a graph with no coupling norms is a no-op.
    const coupled = await couplingNudge({ input, graph, slug, session, cwd, remote }).catch(() => null);
    if (coupled) return coupled;
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

module.exports = { postTool, parseFactList, claimNudge, couplingNudge, agentHeartbeat };
