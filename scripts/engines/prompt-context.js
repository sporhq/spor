"use strict";
// UserPromptSubmit engine: compile a compact relevance digest for this prompt.
// Node port of prompt-context.sh — the trivial-prompt gate runs FIRST in both
// modes; LOCAL mode spawns lib/compile.js exactly as before (byte-identical
// digests); REMOTE mode keeps the 4s budget and the §7.4 team-first merge
// (ported from the awk program line-for-line), 9KB joint ceiling, fail-open.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const u = require("./util");
const { drainPendingNudges, drainPendingDigests, digestSignature, parseDigest } = require("./spool-drain");

const MICRO_MAX_NODES = 5;
const MICRO_MAX_BYTES = 2200;

function envelope(ctx) {
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } };
}

// The ONE description of what a prompt-time compile asks for, consumed by
// BOTH digest branches — the remote POST /v1/digest body and the local
// lib/compile.js argv — so the two cannot drift on project/scope threading
// again (issue-spor-remote-digest-project-blind: the remote branch posted only
// `query` for months while the local one scoped by project). Absent a slug the
// request carries no `project` key, keeping both branches byte-identical to
// their project-blind forms.
function buildCompileRequest(prompt, slug) {
  return slug ? { query: prompt, project: slug } : { query: prompt };
}

function localCompile(graph, req, rlogFile) {
  const r = spawnSync(
    process.execPath,
    [
      path.join(u.ROOT, "lib", "compile.js"),
      "--nodes",
      path.join(graph, "nodes"),
      "--query",
      req.query,
      "--digest",
      "--quiet",
      // The session slug scopes `project:<slug>` corrections (issue-cc-
      // corrections-silent-noop-query-mode). Absent any such correction the
      // digest is byte-identical to before, so local mode stays unchanged for
      // every existing graph.
      ...(req.project ? ["--project", req.project] : []),
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  if (rlogFile && r.stderr) {
    for (const line of r.stderr.split("\n")) if (line) u.appendLine(rlogFile, line);
  }
  if (r.status !== 0 || r.error) return "";
  // $(...) command substitution strips trailing newlines.
  return u.stripTrailingNewlines(r.stdout || "");
}

// §7.4 merge, ported from the awk program in prompt-context.sh. A digest is:
// header lines, node-list lines (`- **id — ...`), then an optional
// `Standing corrections:` footer with guidance lines. Team header + team
// nodes first, local-unique node lines next, then ONE merged corrections
// block deduped by exact line text. If no team digest, local passes through
// unchanged.
function mergeDigests(team, local) {
  if (!team) return local;

  const nodeId = (line) => {
    if (!line.startsWith("- **")) return "";
    return line.slice(4).replace(/ .*$/, "");
  };

  const thead = [];
  const tnode = [];
  const lnode = [];
  const tcorr = [];
  const lcorr = [];
  const parse = (src, isTeam) => {
    let inCorr = false;
    for (const line of src.split("\n")) {
      if (/^Standing corrections:/.test(line)) {
        inCorr = true;
        continue;
      }
      if (inCorr) {
        if (line !== "") (isTeam ? tcorr : lcorr).push(line);
        continue;
      }
      if (line.startsWith("- **")) {
        (isTeam ? tnode : lnode).push(line);
      } else if (isTeam && tnode.length === 0) {
        thead.push(line);
      }
    }
  };
  parse(team, true);
  parse(local, false);

  let out = "";
  const seen = new Set();
  for (const line of thead) out += line + "\n";
  for (const line of tnode) {
    out += line + "\n";
    seen.add(nodeId(line));
  }
  for (const line of lnode) {
    const id = nodeId(line);
    if (id !== "" && !seen.has(id)) {
      seen.add(id);
      out += line + "\n";
    }
  }
  const cseen = new Set();
  const corr = [];
  for (const line of [...tcorr, ...lcorr]) {
    if (!cseen.has(line)) {
      cseen.add(line);
      corr.push(line);
    }
  }
  if (corr.length > 0) {
    out += "\nStanding corrections:\n";
    for (const line of corr) out += line + "\n";
  }
  return out;
}

const CONTINUATION_WORDS = new Set([
  "a", "again", "agreed", "ahead", "alright", "and", "awesome", "back", "carry",
  "continue", "cool", "do", "fine", "go", "going", "good", "great", "it",
  "keep", "let", "lets", "nice", "ok", "okay", "on", "please", "proceed",
  "right", "run", "sounds", "sure", "thanks", "thank", "that", "the", "then",
  "this", "with", "yeah", "yep", "yes", "you", "yup",
]);

function hasHighSignalToken(prompt) {
  const s = String(prompt);
  return /`[^`]+`/.test(s) ||
    /\b(?:task|issue|dec|art|spec|norm|question|repo|proj|corr)-[a-z0-9][a-z0-9-]*\b/i.test(s) ||
    /(?:^|\s)(?:\.{1,2}\/|~\/|[A-Za-z]:\\|[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)/.test(s) ||
    /\b[A-Za-z0-9_.-]+\.(?:c|cc|cs|css|go|h|html|java|js|json|jsx|md|py|rb|rs|sh|sql|ts|tsx|yaml|yml)\b/.test(s);
}

function isContinuationPrompt(prompt) {
  const s = String(prompt).trim();
  if (!s || s.startsWith("/") || hasHighSignalToken(s)) return false;
  const words = (s.toLowerCase().replace(/[’']/g, "").match(/[a-z0-9]+/g) || [])
    .filter((w) => w !== "ll");
  if (!words.length || words.length > 10) return false;
  return words.every((w) => CONTINUATION_WORDS.has(w));
}

function compactNodeLine(line) {
  const m = line.match(/^- \*\*(.+?) — (.+?)\*\* \((.*?)\): (.*)$/);
  if (!m) return line;
  const [, id, title, meta, rest] = m;
  const warning = rest.match(/ ⚠ .+$/);
  const summary = warning ? rest.slice(0, warning.index).trim() : rest.trim();
  const statusMatch = meta.match(/\b(resolved|done|rejected|abandoned|answered|superseded|settled)\b/i);
  const status = statusMatch ? ` (${statusMatch[1].toLowerCase()})` : "";
  return `- ${id}: ${title}${status} — ${summary}${warning ? warning[0] : ""}`;
}

function microDigest(digest, maxNodes = MICRO_MAX_NODES, maxBytes = MICRO_MAX_BYTES) {
  const { nodes, corrections } = parseDigest(digest);
  if (!nodes.length) return u.byteHead(digest, maxBytes);
  let out = "Spor context (top matches; run /spor:brief for full):\n";
  // Whole node lines only: a line's ⚠ note (superseded / resolved) sits at
  // its END, so a mid-line byte cut would inject the node minus the warning
  // that says not to follow it (issue-spor-superseded-context-injected-as-live).
  // The first line always goes in (byteHead below still bounds it).
  for (const [i, line] of nodes.slice(0, maxNodes).entries()) {
    const l = `${compactNodeLine(line)}\n`;
    if (i > 0 && Buffer.byteLength(out + l, "utf8") > maxBytes) break;
    out += l;
  }
  if (corrections.length) {
    out += "\nStanding corrections:\n";
    for (const line of corrections) out += `${line}\n`;
  }
  return u.stripTrailingNewlines(u.byteHead(out, maxBytes));
}

function statePath(graph, input) {
  const sid = input.session_id || input.sessionId || input.conversation_id || input.conversationId;
  if (!sid) return null;
  const h = crypto.createHash("sha256").update(String(sid), "utf8").digest("hex").slice(0, 16);
  return path.join(graph, "journal", `prompt-context-${h}.json`);
}

// Read-only: whether `digest` is the same content already recorded as SHOWN
// (recordDigestShown below) for a low-signal follow-up prompt. Never writes —
// the write happens only once a digest actually clears every later gate
// (issue-spor-prompt-context-repeat-record-before-gate: recording here,
// before the digest-intent gate runs, made a digest the gate went on to
// suppress count as "shown" anyway, wrongly suppressing a later follow-up).
function isRepeatedFollowup(graph, input, prompt, digest) {
  const p = statePath(graph, input);
  if (!p) return false;
  const sig = digestSignature(digest);
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  return prev && prev.sig === sig && !hasHighSignalToken(prompt) && u.wordCount(prompt) <= 12;
}

// Record `digest` as shown, for isRepeatedFollowup's next comparison. Call
// this only at the point a digest is actually being injected THIS turn —
// never from inside computeDigest, which runs before the digest-intent gate
// (server-verdict or async-spool) decides whether to suppress it.
function recordDigestShown(graph, input, digest) {
  const p = statePath(graph, input);
  if (!p) return;
  const sig = digestSignature(digest);
  try {
    u.ensureDir(path.dirname(p));
    u.writeSpoolFile(p, JSON.stringify({ sig, at: new Date().toISOString() }) + "\n");
  } catch {}
}

// Claude Code appends `<system-reminder>…</system-reminder>` blocks
// (scheduled-message timestamps, deferred-tool notices, injected context) to the
// user's text, and they arrive in the hook's `prompt`. Their words must not feed
// the trivial-prompt gates or the retrieval query — otherwise a bare "Continue"
// arrives as 8 words, clears the continuation + word-floor gates, and fires a
// noise digest (issue-spor-digest-continuation-gate-system-reminder-defeat).
// Strip them before anything else looks at the prompt.
function stripSystemReminders(prompt) {
  return String(prompt).replace(/\n*<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "").trim();
}

// dec-spor-digest-noise-needs-async-semantic-intent: the digest over-fires (91%
// of prompts, ~48% warranting none — art-spor-digest-noise-eval-2026-06-25) on
// high-similarity LEXICAL false-matches that no fire-gate threshold separates,
// so the residual gate must be semantic — an LLM call, which cannot live on the
// 30s prompt path (norm-cc-no-llm-prompt-path). digest.async moves it off:
// instead of injecting, spool the computed micro-digest and hand it to a
// DETACHED worker (digest-worker.js) that classifies the prompt's intent; the
// NEXT UserPromptSubmit drains the verdict-passing result with NO LLM call —
// the one-turn-delayed injection the decision blesses. Returns "" once the job
// is spooled; returns the digest UNCHANGED (the shipped synchronous injection)
// on the per-session spawn cap or any spool/spawn failure — fail-open here
// means "inject as before", never "silently withhold a digest".
function spoolDigestIntent(graph, input, slug, prompt, digest) {
  const session = input.session_id ?? "unknown";

  // Per-session ceiling on classifier spawns (digest.intentMaxCalls /
  // SPOR_DIGEST_INTENT_MAX): the digest fires on most substantive prompts, so
  // without a cap a long session pays one backend call per prompt. One state
  // line per spawn (the digest's signature — free observability).
  const state = path.join(graph, "journal", `${session}.digest-intent`);
  let calls = 0;
  try {
    calls = fs.readFileSync(state, "utf8").split("\n").filter(Boolean).length;
  } catch {}
  if (calls >= u.cfgNum("digest.intentMaxCalls", "DIGEST_INTENT_MAX", 20)) return digest;

  const tplFile = path.join(u.ROOT, "prompts", "client", "digest-intent.md");
  if (!fs.existsSync(tplFile)) return digest;
  const vars = { SLUG: slug, PROMPT: prompt, DIGEST: digest };
  const job = {
    prompt: u.fillTemplate(u.stripTrailingNewlines(fs.readFileSync(tplFile, "utf8")), vars),
    tplSha: u.sha256Head(tplFile),
    session,
    slug,
    graph,
    timeoutMs: u.cfgNum("digest.intentTimeoutMs", "DIGEST_INTENT_TIMEOUT", 30000),
    cmd: u.cfgStr("digest.intentCmd", "DIGEST_INTENT_CMD") || u.hostDefaultBackendCmd("nudge") || "",
    vars,
    digest,
    sig: digestSignature(digest),
  };

  const spoolDir = path.join(graph, "journal", "pending-digests", session);
  if (!u.ensureDir(spoolDir)) return digest;
  const hash = `${Date.now()}-${u.bashRandom()}`;
  const inFile = path.join(spoolDir, `${hash}.in.json`);
  try {
    u.writeSpoolFile(inFile, JSON.stringify({ ...job, hash }));
  } catch {
    return digest;
  }
  u.appendLine(state, job.sig);
  u.appendLine(
    path.join(graph, "journal", `${session}.jsonl`),
    JSON.stringify({ ts: u.jqNow(), project: slug, tool: "digest-intent-spawn" })
  );
  u.spawnDetached([path.join(__dirname, "digest-worker.js"), inFile]);
  return "";
}

// The intent-classifier call itself, run by scripts/engines/digest-worker.js
// OFF the prompt path. Same backend seam as the capture nudge (prompt on
// stdin -> verdict on stdout; default `claude -p --model haiku`), recorded to
// journal/llm-calls as source "digest-intent" for the nightly review loop.
// Returns "WARRANTED" | "UNWARRANTED" | null (backend failure / unparseable).
// The verdict only ever REMOVES noise: the worker treats anything but an
// explicit UNWARRANTED as inject, so a broken backend degrades to the shipped
// inject-everything behavior instead of silently eating warranted digests.
function classifyDigestIntent({ prompt, tplSha, session, slug, graph, timeoutMs, cmd, vars }) {
  const res = u.runClassifierBackend({
    prompt,
    tplSha,
    session,
    project: slug,
    graph,
    source: "digest-intent",
    template: "digest-intent.md",
    timeoutMs,
    cmd,
    vars,
  });
  if (res === null) return null;

  // \b keeps the two tests independent (`\bWARRANTED\b` can't match inside
  // "UNWARRANTED" — no boundary after the N). Suppression needs an UNAMBIGUOUS
  // verdict: a reply carrying both tokens ("WARRANTED — not UNWARRANTED") or
  // neither is null, which the worker fails open to inject.
  const un = /\bUNWARRANTED\b/.test(res.response);
  const w = /\bWARRANTED\b/.test(res.response);
  if (un && !w) return "UNWARRANTED";
  if (w && !un) return "WARRANTED";
  return null;
}

// Whether an UNSET digest.async honors the server-computed intent verdict
// (task-spor-digest-intent-jev-gate). It never spawns the client-side Haiku
// classifier — that stays behind an explicit digest.async:true — so flipping
// this changes nothing in local mode or against a server that returns no
// `intent`. See scripts/intent-eval/README.md "Jev (server-side)" for the
// held-out measurement it rests on.
const INTENT_GATE_DEFAULT = false;

async function promptContext(input) {
  // Headless backend invocations (the capture ingester, the fact-finder
  // distiller, the nudge classifier — every spawn site exports the
  // SPOR_DISTILLING marker, client and server) are not user prompts: a digest
  // injected there is compile work no human reads, and it polluted the digest
  // eval set (issue-spor-digest-fires-on-headless-backend-personas). Same
  // guard post-tool already applies ("headless calls don't nudge").
  if (u.isSystemSession()) return null;

  const graph = u.graphHome();
  const slug = u.projectSlug(input.cwd ?? "");

  // Drain any async-nudge results BEFORE the digest gates — a pending finding
  // must inject on a trivial/continuation prompt too. Gated on nudge.async so
  // the default (synchronous) path pays no extra syscall and stays
  // byte-identical, AND on nudge.enabled so SPOR_NUDGE=0 suppresses the drain
  // exactly as it suppresses the post-tool spawn (never inject a nudge the user
  // just disabled). No LLM here (norm-cc-no-llm-prompt-path).
  const pendingNudge =
    u.cfgBool("nudge.enabled", "NUDGE", true) && u.cfgBool("nudge.async", "NUDGE_ASYNC", false)
      ? drainPendingNudges(graph, input, slug)
      : "";

  const meta = {};
  let digest = await computeDigest(input, graph, slug, meta);
  // Whether the digest about to be injected THIS turn is this turn's own
  // compute (meta.rawDigest) rather than a `pending` one drained from an
  // earlier turn's spool — only the former gets recorded as "shown"
  // (recordDigestShown below), since a drained pending digest already has its
  // own dedup via `<session>.digest-injected` and never had a `rawDigest`
  // captured for it. Starts true (the default, no-gate path injects whatever
  // computeDigest returned) and is corrected by the gates below.
  let thisTurnInjected = !!digest;

  // digest.async is a TRI-STATE (task-spor-digest-intent-jev-gate): explicit
  // true is the full async gate below, explicit false is no gate at all, and
  // unset resolves to INTENT_GATE_DEFAULT — which honors a verdict the SERVER
  // computed but never spawns a client-side classifier.
  const asyncFlag = u.cfgBool("digest.async", "DIGEST_ASYNC", null);
  const intentGate = asyncFlag ?? INTENT_GATE_DEFAULT;

  // The server-computed intent verdict (/v1/digest's `intent`, computed by Jev
  // in the tenant server — dec-spor-jev-calls-proxied-through-tenant-server).
  // It rides the response this prompt already waited for, so it decides THIS
  // prompt synchronously: no spool, no one-turn delay, and no LLM on the client
  // prompt path (norm-cc-no-llm-prompt-path). Only an explicit
  // `warranted: false` suppresses; an absent or malformed field (local mode, an
  // older server, Jev disabled/failed server-side) falls through to exactly the
  // behavior without it.
  if (intentGate && digest && meta.intent) {
    const session = input.session_id ?? "unknown";
    const it = meta.intent;
    u.appendLine(
      path.join(graph, "journal", `${session}.jsonl`),
      JSON.stringify({
        ts: u.jqNow(),
        project: slug,
        tool: "digest-intent",
        source: typeof it.source === "string" ? it.source : "server",
        warranted: it.warranted,
        ...(typeof it.needs_history === "number" ? { needs_history: it.needs_history } : {}),
        ...(typeof it.digest_helps === "number" ? { digest_helps: it.digest_helps } : {}),
      })
    );
    if (!it.warranted) {
      digest = "";
      thisTurnInjected = false;
    }
    // Under the explicit async gate, a result the Haiku worker spooled for an
    // EARLIER prompt is superseded by this fresher verdict: consume it without
    // injecting, and record an injected digest's signature for the drain dedup
    // — the same bookkeeping as the synchronous fallback below.
    if (asyncFlag === true) {
      drainPendingDigests(graph, input, slug, { suppress: true });
      if (digest) u.appendLine(path.join(graph, "journal", `${session}.digest-injected`), digestSignature(digest));
    }
  } else if (asyncFlag === true) {
    // digest.async (dec-spor-digest-noise-needs-async-semantic-intent): gate the
    // digest behind the off-prompt-path intent classifier. The compute above ran
    // exactly as before; here it is spooled instead of injected (spool returns
    // the digest unchanged on the spawn cap / spool failure — synchronous
    // fail-open), and whatever the worker cleared LAST prompt drains in with no
    // LLM call. Both branches are gated on the EXPLICIT flag, so the default
    // path adds no syscall and stays byte-identical.
    const fresh = digest
      ? spoolDigestIntent(graph, input, slug, stripSystemReminders(input.prompt ?? ""), digest)
      : "";
    // The drain always runs (consuming stale results) — suppressed from
    // injecting only when a fresh synchronous digest already takes the slot.
    const pending = drainPendingDigests(graph, input, slug, { suppress: !!fresh });
    // A fallback synchronous injection still records its signature, so a
    // late-landing pending result carrying the same digest can't re-inject
    // identical context on the next prompt.
    if (fresh) {
      const session = input.session_id ?? "unknown";
      u.appendLine(path.join(graph, "journal", `${session}.digest-injected`), digestSignature(fresh));
    }
    digest = fresh || pending;
    thisTurnInjected = !!fresh;
  }

  // A digest actually injected THIS turn from THIS turn's own compute is now
  // recorded as shown, so a later low-signal follow-up repeating identical
  // content can be suppressed. A digest the intent gate suppressed (digest
  // set to "" above) never reaches here, and a `pending` digest drained from
  // an earlier turn's spool is excluded by `thisTurnInjected` — it has its
  // own dedup and no captured `rawDigest` to compare against
  // (issue-spor-prompt-context-repeat-record-before-gate).
  if (thisTurnInjected && meta.rawDigest) recordDigestShown(graph, input, meta.rawDigest);

  const parts = [pendingNudge, digest].filter(Boolean);
  if (!parts.length) return null;
  // Cap the combined context at the host's 10KB additionalContext ceiling so a
  // large merged nudge can't get truncated mid-structure by the host. The
  // digest-only path is byte-identical: microDigest already self-caps well
  // under 10KB, so this byteHead is a no-op there.
  return envelope(u.byteHead(parts.join("\n\n"), 10000));
}

// The relevance digest, byte-identical to the pre-async behavior: returns the
// microdigest context string, or "" when a gate suppresses it (the callers
// combine it with any pending async nudge). Every prior `return null` here is a
// `return ""`; every `return envelope(x)` is a `return x`.
async function computeDigest(input, graph, slug, meta = {}) {
  const prompt = stripSystemReminders(input.prompt ?? "");

  // Skip trivial / continuation prompts BEFORE any network call. The second
  // gate catches "ok let's do that" follow-ups that carry no new retrieval
  // signal but can otherwise clear the word floor.
  if (prompt.startsWith("/")) return "";
  if (isContinuationPrompt(prompt)) return "";
  if (u.wordCount(prompt) < 6) return "";
  const req = buildCompileRequest(prompt, slug);

  // -------------------------------------------------------------------------
  // REMOTE MODE
  // -------------------------------------------------------------------------
  if (u.serverBase()) {
    u.ensureDir(path.join(graph, "journal"));
    const rlogFile = path.join(graph, "journal", "remote.log");
    const rlog = u.makeLogger(rlogFile, "prompt-context: ");

    // Send the session project so the SERVER-side compile applies the same
    // project scoping the local digest already gets — the same-project
    // relevance boost, the grouping union, and the norm `applies_to_*`
    // ride-along (issue-spor-remote-digest-project-blind). The remote digest
    // was project-blind: it posted only `query`, so every compile() session-
    // project feature silently no-opped in remote mode. The body is the same
    // buildCompileRequest() the local merge below compiles from. Absent a slug
    // it is byte-identical to the prior project-blind POST, and an older
    // server simply ignores the field (it stays the default), so this is safe
    // either way.
    const resp = await u.curlWithRefresh(`${u.serverBase()}/v1/digest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      timeoutMs: 4000,
    });

    let team = "";
    if (resp.http === "200" && resp.body) {
      let found = false;
      try {
        const parsed = JSON.parse(resp.body);
        found = parsed.found ?? false;
        if (found === true) team = u.stripTrailingNewlines(parsed.text ?? "");
        // The server's intent verdict for this prompt, when it computed one
        // (API.md §3 /v1/digest `intent`). Accepted only with a boolean
        // `warranted` AND a found team digest — its `digest_helps` noul judged
        // THAT digest, so on `found:false` it says nothing about a personal-
        // graph digest the server never saw. Anything else is ignored — fail
        // open to inject.
        const it = parsed.intent;
        if (found === true && it && typeof it === "object" && typeof it.warranted === "boolean") meta.intent = it;
      } catch {}
      rlog(`digest ok (found=${found}, http=${resp.http})`);
    } else {
      rlog(`digest unreachable (http=${resp.http}); failing open`);
    }

    // §7.4 multi-root: also run the local personal compile when a personal
    // graph exists.
    let local = "";
    if (fs.existsSync(path.join(graph, "nodes"))) {
      local = localCompile(graph, req, rlogFile);
    }

    if (!team && !local) return "";
    // MERGED=$(awk ... | head -c 9216) — command substitution strips trailing
    // newlines before jq sees it.
    const merged = u.stripTrailingNewlines(u.byteHead(mergeDigests(team, local), 9216));
    if (!/\S/.test(merged)) return "";
    meta.rawDigest = merged;
    if (isRepeatedFollowup(graph, input, prompt, merged)) return "";
    return microDigest(merged);
  }

  // -------------------------------------------------------------------------
  // LOCAL MODE (original behavior — byte-identical to prompt-context.sh)
  // -------------------------------------------------------------------------
  if (!fs.existsSync(path.join(graph, "nodes"))) return "";
  // Time the compile subprocess and stamp it to the journal
  // (issue-cc-local-mode-hook-load-latency): lib/compile.js reloads the whole
  // graph per prompt with no cache, and because hooks fail open the latency
  // never trips the 30s budget — so the creep is invisible. The stamp is the
  // missing signal; it is journal-only, so the injected digest stays
  // byte-identical. Best-effort; never blocks.
  const t0 = Date.now();
  const digest = localCompile(graph, req, null);
  u.journalLoadMs(graph, input.session_id, "prompt-context", Date.now() - t0, {
    cached: false,
  });
  if (!digest) return "";
  meta.rawDigest = digest;
  if (isRepeatedFollowup(graph, input, prompt, digest)) return "";
  return microDigest(digest);
}

module.exports = {
  promptContext,
  buildCompileRequest,
  mergeDigests,
  isContinuationPrompt,
  stripSystemReminders,
  microDigest,
  drainPendingNudges,
  drainPendingDigests,
  classifyDigestIntent,
  INTENT_GATE_DEFAULT,
};
