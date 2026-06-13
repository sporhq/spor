"use strict";
// SessionStart engine: inject the standing project briefing plus a one-line
// status. Node port of session-start.sh — LOCAL mode is byte-identical to the
// original pure-file-read behavior; REMOTE mode keeps the same budgets
// (drain 2s/1 file, briefing 6s, queue 3s), cache format, and fail-open
// fallbacks. Returns the Claude-shaped envelope object, or null for no output.

const fs = require("fs");
const path = require("path");
const u = require("./util");
const { drainOutbox } = require("./drain-outbox");

const USAGE =
  "Use /spor:brief <query or node-id> for a task-specific briefing, /spor:correct to fix a bad briefing.";
const USAGE_REMOTE =
  USAGE +
  " When you defer discovered work mid-task (out-of-scope fix, follow-up, dismissed approach), capture it the moment you defer it: /spor:defer <2-3 sentences, what + why> — one call, the server types and links it.";

function envelope(ctx) {
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } };
}

// Body of a node file = everything after the second '---' line, like
// `awk 'f{print} /^---$/{c++; if(c==2)f=1}'` (then head -c 7000 and the
// command-substitution trailing-newline strip).
function nodeBody(raw) {
  const lines = raw.split("\n");
  let dashes = 0;
  const out = [];
  for (const line of lines) {
    if (dashes >= 2) out.push(line);
    if (line === "---") dashes++;
  }
  // awk print emits a trailing newline per line; head -c counts those bytes.
  const awkOut = out.length ? out.join("\n") + "\n" : "";
  return u.stripTrailingNewlines(u.byteHead(awkOut, 7000));
}

async function sessionStart(input) {
  const graph = u.graphHome();
  const nodes = path.join(graph, "nodes");
  const cwd = input.cwd ?? "";
  const slug = u.projectSlug(cwd);

  // Persist the plugin root so skills can locate lib/ from the Bash tool,
  // where ${CLAUDE_PLUGIN_ROOT} is unset (issue-cc-skill-plugin-root-
  // unsubstituted). The hooks.json command string is the one place the host
  // substitutes the root; u.ROOT is that same plugin root resolved from the
  // engine's own location. Local-mode skill commands read this file. Best
  // effort — failure is harmless (skills fall back to ${CLAUDE_PLUGIN_ROOT}).
  try {
    const cacheDir = path.join(graph, "cache");
    u.ensureDir(cacheDir);
    fs.writeFileSync(path.join(cacheDir, "plugin-root"), `${u.ROOT}\n`);
  } catch {
    /* best effort */
  }

  // -------------------------------------------------------------------------
  // REMOTE MODE
  // -------------------------------------------------------------------------
  if (u.serverBase()) {
    const cacheDir = path.join(graph, "cache");
    const cache = path.join(cacheDir, `brief-${slug}.md`);
    u.ensureDir(cacheDir);
    u.ensureDir(path.join(graph, "journal"));
    const rlog = u.makeLogger(path.join(graph, "journal", "remote.log"), `session-start ${slug}: `);

    // Drain spooled nodes with a TIGHT budget (2s/file, 1 file, no retries) —
    // session-start has only ~6s total (§7.1).
    await drainOutbox(graph, "session-start", 2, 1).catch(() => {});

    // Commit-link catch-up (task-cc-commit-linking): detached, costs nothing.
    if (cwd && fs.existsSync(cwd)) {
      u.spawnDetached([path.join(__dirname, "link-commits.js"), cwd]);
    }

    // Fetch the standing briefing. Budget 6s. Fail open. Repo fingerprints
    // (root shas + normalized remotes) ride along so the server can learn
    // them onto the project node and spot renames — an unknown slug with a
    // known fingerprint files an alias proposal in the queue
    // (task-cc-project-identity-nodes). Local git calls, ms-cheap, fail-open.
    const fp = cwd && fs.existsSync(cwd) ? u.repoFingerprints(cwd) : [];
    const brief = await u.curl(
      `${u.serverBase()}/v1/briefing/${slug}${fp.length ? `?fp=${encodeURIComponent(fp.join(","))}` : ""}`,
      {
        headers: u.bearer(),
        timeoutMs: 6000,
      }
    );
    const host = u.serverHost();

    // Tier-2: questions routed to this identity + the open front, riding one
    // queue response. Fail open: any failure leaves the lines empty.
    let qline = "";
    let oline = "";
    const qresp = await u.curl(`${u.serverBase()}/v1/queue?limit=1`, {
      headers: u.bearer(),
      timeoutMs: 3000,
    });
    try {
      const q = JSON.parse(qresp.body);
      const qn = Array.isArray(q.questions) ? q.questions.length : 0;
      if (qn > 0) {
        const qids = q.questions.map((x) => x.id).join(", ");
        qline = `\n${qn} question(s) routed to you: ${qids} — answer by writing a node with an answers edge to the question, then set its status to answered.`;
      }
      const item = (q.items || [])[0];
      if (item && item.id) {
        const why = item.why || "";
        oline = `\nopen front: ${item.id} — ${item.title || ""}${why ? ` (${why})` : ""}`;
        if ((item.suggest || "do") === "close") oline += " — the queue suggests CLOSING it, not doing it";
        oline += ". Full queue: /spor:next.";
      }
    } catch {
      /* fail open */
    }

    if (brief.http === "200" && brief.body) {
      let resp = null;
      try {
        resp = JSON.parse(brief.body);
      } catch {}
      const found = resp?.found ?? false;
      const ncount = resp?.graph_status?.node_count ?? 0;
      if (found === true) {
        const body = u.stripTrailingNewlines(resp.body ?? "");
        const version = resp.version ?? 1;
        // Cache the body (with version + fetch timestamp) for offline starts.
        try {
          fs.writeFileSync(
            cache,
            `<!-- spor cache: brief-${slug} version=${version} fetched=${u.isoSeconds()} host=${host} -->\n${body}\n`
          );
        } catch {
          rlog("cache write failed");
        }
        rlog(`briefing ok (v${version}, ${ncount} nodes)`);
        const ctx = `team graph: ${ncount} nodes @ ${host}. ${USAGE_REMOTE}${qline}${oline}

## Standing project briefing (brief-${slug} v${version}, machine-compiled from the team graph — correct it with /spor:correct, don't silently work around errors)

${u.byteHead(body, 7000)}`;
        return envelope(ctx);
      }
      // 200 but no briefing for this project: still note the graph status.
      rlog(`briefing not found for ${slug} (${ncount} nodes)`);
      return envelope(
        `team graph: ${ncount} nodes @ ${host} (no standing briefing for ${slug} yet). ${USAGE_REMOTE}${qline}${oline}`
      );
    }

    // Server unreachable / non-200 / empty: fail open onto the cache.
    rlog(`server unreachable (http=${brief.http}); falling back to cache`);
    if (fs.existsSync(cache)) {
      let raw = "";
      try {
        raw = fs.readFileSync(cache, "utf8");
      } catch {}
      // dual-read: caches written before the Spor rename carry the old marker
      const isMarker = (l) => l.startsWith("<!-- spor cache:") || l.startsWith("<!-- substrate cache:");
      const headerLine = raw.split("\n").find(isMarker);
      const fetched = headerLine?.match(/fetched=([^ ]+)/)?.[1] || "";
      const body = u.stripTrailingNewlines(
        u.byteHead(
          raw.split("\n").filter((l) => !isMarker(l)).join("\n"),
          7000
        )
      );
      const ctx = `team graph: OFFLINE (could not reach ${host}). Showing cached briefing fetched ${fetched || "unknown"} — it may be stale.

## Standing project briefing (brief-${slug}, cached from the team graph)

${body}`;
      return envelope(ctx);
    }
    rlog("no cache available; injecting nothing");
    return null;
  }

  // -------------------------------------------------------------------------
  // LOCAL MODE (original behavior — byte-identical to session-start.sh)
  // -------------------------------------------------------------------------
  if (!fs.existsSync(nodes)) return null;

  let files = [];
  try {
    files = fs.readdirSync(nodes).filter((f) => f.endsWith(".md"));
  } catch {
    return null;
  }
  const count = files.length;
  // Project identity (task-cc-project-identity-nodes): a resident `type:
  // project` node whose `slugs:` register (or id) includes this session's
  // slug widens matching to every alias it owns — historical stamps stay as
  // written and resolve at read time. One scan collects both the per-file
  // `project: X` lines (the old grep) and the project nodes; with no project
  // node claiming the slug the alias set is {slug} and behavior is
  // byte-identical to the original.
  const stamps = []; // per file: the exact `project: ` line values it carries
  const projects = []; // resident project nodes: { id, slugs }
  for (const f of files) {
    try {
      const lines = fs.readFileSync(path.join(nodes, f), "utf8").split("\n");
      stamps.push(lines.filter((l) => l.startsWith("project: ")).map((l) => l.slice(9)));
      if (lines.includes("type: project")) {
        const id = lines.find((l) => l.startsWith("id: "))?.slice(4).trim() ?? "";
        const m = lines.find((l) => l.startsWith("slugs:"))?.match(/\[([^\]]*)\]/);
        projects.push({ id, slugs: (m?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) });
      }
    } catch {
      stamps.push([]);
    }
  }
  const owner = projects.find((p) => p.id === slug || p.slugs.includes(slug));
  const aliases = new Set([slug, ...(owner?.slugs ?? [])]);
  const projCount = stamps.filter((vals) => vals.some((v) => aliases.has(v))).length;
  let ctx = `A Spor knowledge graph is active: ${count} nodes in ${nodes} (${projCount} tagged project: ${slug}). ${USAGE}`;

  // brief-<slug> lookup resolves the same aliases: exact slug first, then
  // the owning project node's other slugs newest-first (last entry is the
  // current name).
  const briefCandidates = [slug, ...(owner?.slugs ?? []).slice().reverse().filter((s) => s !== slug)];
  const briefSlug = briefCandidates.find((s) => fs.existsSync(path.join(nodes, `brief-${s}.md`)));
  if (briefSlug) {
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(nodes, `brief-${briefSlug}.md`), "utf8");
    } catch {}
    const body = nodeBody(raw);
    const version = raw.match(/^version: *(.*)$/m)?.[1] ?? "";
    ctx += `

## Standing project briefing (brief-${briefSlug} v${version || "1"}, machine-compiled — correct it with /spor:correct, don't silently work around errors)

${body}`;
  }

  return envelope(ctx);
}

module.exports = { sessionStart };
