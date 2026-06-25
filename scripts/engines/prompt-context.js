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

const MICRO_MAX_NODES = 5;
const MICRO_MAX_BYTES = 2200;

function envelope(ctx) {
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ctx } };
}

function localCompile(graph, prompt, rlogFile, project) {
  const r = spawnSync(
    process.execPath,
    [
      path.join(u.ROOT, "lib", "compile.js"),
      "--nodes",
      path.join(graph, "nodes"),
      "--query",
      prompt,
      "--digest",
      "--quiet",
      // The session slug scopes `project:<slug>` corrections (issue-cc-
      // corrections-silent-noop-query-mode). Absent any such correction the
      // digest is byte-identical to before, so local mode stays unchanged for
      // every existing graph.
      ...(project ? ["--project", project] : []),
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

function parseDigest(digest) {
  const header = [];
  const nodes = [];
  const corrections = [];
  let inCorr = false;
  for (const line of String(digest).split("\n")) {
    if (/^Standing corrections:/.test(line)) {
      inCorr = true;
      continue;
    }
    if (inCorr) {
      if (line.trim()) corrections.push(line);
      continue;
    }
    if (line.startsWith("- **")) nodes.push(line);
    else if (!nodes.length && line.trim()) header.push(line);
  }
  return { header, nodes, corrections };
}

function compactNodeLine(line) {
  const m = line.match(/^- \*\*(.+?) — (.+?)\*\* \((.*?)\): (.*)$/);
  if (!m) return line;
  const [, id, title, meta, rest] = m;
  const warning = rest.match(/ ⚠ .+$/);
  const summary = warning ? rest.slice(0, warning.index).trim() : rest.trim();
  const statusMatch = meta.match(/\b(resolved|done|rejected|abandoned|answered)\b/i);
  const status = statusMatch ? ` (${statusMatch[1].toLowerCase()})` : "";
  return `- ${id}: ${title}${status} — ${summary}${warning ? warning[0] : ""}`;
}

function microDigest(digest, maxNodes = MICRO_MAX_NODES, maxBytes = MICRO_MAX_BYTES) {
  const { nodes, corrections } = parseDigest(digest);
  if (!nodes.length) return u.byteHead(digest, maxBytes);
  let out = "Spor context (top matches; run /spor:brief for full):\n";
  for (const line of nodes.slice(0, maxNodes)) out += `${compactNodeLine(line)}\n`;
  if (corrections.length) {
    out += "\nStanding corrections:\n";
    for (const line of corrections) out += `${line}\n`;
  }
  return u.stripTrailingNewlines(u.byteHead(out, maxBytes));
}

function digestSignature(digest) {
  const { nodes, corrections } = parseDigest(digest);
  const basis = nodes.map((l) => l.replace(/: .*/, "")).join("\n") + "\n--\n" + corrections.join("\n");
  return crypto.createHash("sha256").update(basis || digest, "utf8").digest("hex");
}

function statePath(graph, input) {
  const sid = input.session_id || input.sessionId || input.conversation_id || input.conversationId;
  if (!sid) return null;
  const h = crypto.createHash("sha256").update(String(sid), "utf8").digest("hex").slice(0, 16);
  return path.join(graph, "journal", `prompt-context-${h}.json`);
}

function repeatedFollowup(graph, input, prompt, digest) {
  const p = statePath(graph, input);
  if (!p) return false;
  const sig = digestSignature(digest);
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  try {
    u.ensureDir(path.dirname(p));
    fs.writeFileSync(p, JSON.stringify({ sig, at: new Date().toISOString() }) + "\n");
  } catch {}
  return prev && prev.sig === sig && !hasHighSignalToken(prompt) && u.wordCount(prompt) <= 12;
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

async function promptContext(input) {
  const graph = u.graphHome();
  const prompt = stripSystemReminders(input.prompt ?? "");
  const slug = u.projectSlug(input.cwd ?? "");

  // Skip trivial / continuation prompts BEFORE any network call. The second
  // gate catches "ok let's do that" follow-ups that carry no new retrieval
  // signal but can otherwise clear the word floor.
  if (prompt.startsWith("/")) return null;
  if (isContinuationPrompt(prompt)) return null;
  if (u.wordCount(prompt) < 6) return null;

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
    // project feature silently no-opped in remote mode. `slug` is the same
    // `projectSlug(cwd)` already fed to the local merge below. Absent a slug
    // the body is byte-identical to the prior project-blind POST, and an older
    // server simply ignores the field (it stays the default), so this is safe
    // either way.
    const resp = await u.curl(`${u.serverBase()}/v1/digest`, {
      method: "POST",
      headers: { ...u.bearer(), "Content-Type": "application/json" },
      body: JSON.stringify(slug ? { query: prompt, project: slug } : { query: prompt }),
      timeoutMs: 4000,
    });

    let team = "";
    if (resp.http === "200" && resp.body) {
      let found = false;
      try {
        const parsed = JSON.parse(resp.body);
        found = parsed.found ?? false;
        if (found === true) team = u.stripTrailingNewlines(parsed.text ?? "");
      } catch {}
      rlog(`digest ok (found=${found}, http=${resp.http})`);
    } else {
      rlog(`digest unreachable (http=${resp.http}); failing open`);
    }

    // §7.4 multi-root: also run the local personal compile when a personal
    // graph exists.
    let local = "";
    if (fs.existsSync(path.join(graph, "nodes"))) {
      local = localCompile(graph, prompt, rlogFile, slug);
    }

    if (!team && !local) return null;
    // MERGED=$(awk ... | head -c 9216) — command substitution strips trailing
    // newlines before jq sees it.
    const merged = u.stripTrailingNewlines(u.byteHead(mergeDigests(team, local), 9216));
    if (!/\S/.test(merged)) return null;
    if (repeatedFollowup(graph, input, prompt, merged)) return null;
    return envelope(microDigest(merged));
  }

  // -------------------------------------------------------------------------
  // LOCAL MODE (original behavior — byte-identical to prompt-context.sh)
  // -------------------------------------------------------------------------
  if (!fs.existsSync(path.join(graph, "nodes"))) return null;
  // Time the compile subprocess and stamp it to the journal
  // (issue-cc-local-mode-hook-load-latency): lib/compile.js reloads the whole
  // graph per prompt with no cache, and because hooks fail open the latency
  // never trips the 30s budget — so the creep is invisible. The stamp is the
  // missing signal; it is journal-only, so the injected digest stays
  // byte-identical. Best-effort; never blocks.
  const t0 = Date.now();
  const digest = localCompile(graph, prompt, null, slug);
  u.journalLoadMs(graph, input.session_id, "prompt-context", Date.now() - t0, {
    cached: false,
  });
  if (!digest) return null;
  if (repeatedFollowup(graph, input, prompt, digest)) return null;
  return envelope(microDigest(digest));
}

module.exports = { promptContext, mergeDigests, isContinuationPrompt, microDigest };
