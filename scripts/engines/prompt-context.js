"use strict";
// UserPromptSubmit engine: compile a compact relevance digest for this prompt.
// Node port of prompt-context.sh — the trivial-prompt gate runs FIRST in both
// modes; LOCAL mode spawns lib/compile.js exactly as before (byte-identical
// digests); REMOTE mode keeps the 4s budget and the §7.4 team-first merge
// (ported from the awk program line-for-line), 9KB joint ceiling, fail-open.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const u = require("./util");

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

async function promptContext(input) {
  const graph = u.graphHome();
  const prompt = input.prompt ?? "";
  const slug = u.projectSlug(input.cwd ?? "");

  // Skip trivial prompts (slash commands, <6 words) BEFORE any network call.
  if (prompt.startsWith("/")) return null;
  if (u.wordCount(prompt) < 6) return null;

  // -------------------------------------------------------------------------
  // REMOTE MODE
  // -------------------------------------------------------------------------
  if (u.serverBase()) {
    u.ensureDir(path.join(graph, "journal"));
    const rlogFile = path.join(graph, "journal", "remote.log");
    const rlog = u.makeLogger(rlogFile, "prompt-context: ");

    const resp = await u.curl(`${u.serverBase()}/v1/digest`, {
      method: "POST",
      headers: { ...u.bearer(), "Content-Type": "application/json" },
      body: JSON.stringify({ query: prompt }),
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
    return envelope(merged);
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
  return envelope(digest);
}

module.exports = { promptContext, mergeDigests };
