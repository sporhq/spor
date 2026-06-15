"use strict";
// SessionStart engine: inject the standing project briefing plus a one-line
// status. Node port of session-start.sh — LOCAL mode is byte-identical to the
// original pure-file-read behavior; REMOTE mode keeps the same budgets
// (drain 2s/1 file, briefing 6s, queue 3s), cache format, and fail-open
// fallbacks. Returns the Claude-shaped envelope object, or null for no output.

const fs = require("fs");
const path = require("path");
const u = require("./util");

const USAGE =
  "Use /spor:brief <query or node-id> for a task-specific briefing, /spor:correct to fix a bad briefing.";
const USAGE_REMOTE =
  USAGE +
  " When you defer discovered work mid-task (out-of-scope fix, follow-up, dismissed approach), capture it the moment you defer it: /spor:defer <2-3 sentences, what + why> — one call, the server types and links it.";
// Local mode has no server ingester; /spor:defer writes the node itself.
// Same standing capture prompt so solo users get the capture-and-resurface
// flywheel (issue-cc-local-mode-capture-queue-surfacing-gap).
const USAGE_LOCAL =
  USAGE +
  " When you defer discovered work mid-task (out-of-scope fix, follow-up, dismissed approach), capture it the moment you defer it: /spor:defer <2-3 sentences, what + why>. Show what to work on next with /spor:next.";

function envelope(ctx) {
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } };
}

// Project grouping brief (task-cc-grouping-brief-digest-reads): the briefing
// response may carry a `project_brief` for the `type: project` grouping this
// repo is grouped-under (the product layer above the per-repo brief). Format it
// as an additional block injected alongside the repo brief; "" when absent.
// Fail-open: any malformed payload yields no block.
function projectBriefBlock(resp) {
  try {
    const pb = resp?.project_brief;
    if (!pb || !pb.body) return "";
    const v = pb.version ?? 1;
    return `

## Standing PRODUCT briefing (${pb.id} v${v}, the grouping above this repo — context spanning every repo in the product)

${u.byteHead(u.stripTrailingNewlines(pb.body), 7000)}`;
  } catch {
    return "";
  }
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

// Durable repo-identity node text (issue-spor-onboard-no-repo-identity-node),
// mirroring the server's learnFingerprints registration so local and remote
// produce the same shape. Ungrouped by default — no grouped-under edge; the
// standing grouping suggester proposes the single home project.
function repoNodeMarkdown(slug, fp, today) {
  return `---
id: repo-${slug}
type: repo
title: ${slug}
summary: Git-repo identity for '${slug}', auto-registered from its fingerprints when the repo first appeared in the local graph. Ungrouped — no home project yet; the grouping suggester proposes a grouped-under home.
slugs: [${slug}]
fingerprints: [${fp.join(", ")}]
date: ${today}
---

Auto-registered repo identity for \`${slug}\` (issue-spor-onboard-no-repo-identity-node). Created on first sight so the repo is a first-class node: the anchor for rename-healing fingerprint matching and for a \`grouped-under\` home. It starts UNGROUPED by default — repo-scoped reads work on the slug, and the standing grouping suggester proposes its single home project for confirmation. Slug aliases and fingerprints accumulate here across renames and re-clones.
`;
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

    // Drain spooled nodes DETACHED: it is independent of the briefing/queue
    // fetch and must not add to the response latency. Awaiting it serially
    // stacked its 2s onto the briefing's 6s and the queue's 3s, blowing the
    // ~6s session-start budget (§7.1, issue-cc-session-start-serial-timeout-
    // budget). Detaching it (and the commit catch-up) leaves only the two
    // server reads on the critical path, which now run concurrently.
    u.spawnDetached([path.join(__dirname, "drain-outbox.js"), "session-start", "2", "1"]);

    // Commit-link catch-up (task-cc-commit-linking): detached, costs nothing.
    if (cwd && fs.existsSync(cwd)) {
      u.spawnDetached([path.join(__dirname, "link-commits.js"), cwd]);
    }

    // Fetch the standing briefing (6s) and the queue (3s) CONCURRENTLY rather
    // than serially: they are independent reads, so the critical path is the
    // slower of the two (~6s), not their sum (~9s). Both fail open. Repo
    // fingerprints (root shas + normalized remotes) ride the briefing call so
    // the server can learn them onto the project node and spot renames — an
    // unknown slug with a known fingerprint files an alias proposal in the
    // queue (task-cc-project-identity-nodes). Local git calls, ms-cheap, fail-open.
    const fp = cwd && fs.existsSync(cwd) ? u.repoFingerprints(cwd) : [];
    const [brief, qresp] = await Promise.all([
      u.curl(
        `${u.serverBase()}/v1/briefing/${slug}${fp.length ? `?fp=${encodeURIComponent(fp.join(","))}` : ""}`,
        {
          headers: u.bearer(),
          timeoutMs: 6000,
        }
      ),
      u.curl(`${u.serverBase()}/v1/queue?limit=1`, {
        headers: u.bearer(),
        timeoutMs: 3000,
      }),
    ]);
    const host = u.serverHost();

    // Tier-2: questions routed to this identity + the open front, riding one
    // queue response. Fail open: any failure leaves the lines empty.
    let qline = "";
    let oline = "";
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
        // Emitted phrasing is deliberately plain ("next up:", not the internal
        // "open front" coinage) so it doesn't prime the agent to parrot jargon
        // at the human (issue-cc-skill-queue-jargon-mode-theater). The concept
        // is still the open front; only the user-facing words changed.
        oline = `\nnext up: ${item.id} — ${item.title || ""}${why ? ` (${why})` : ""}`;
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

${u.byteHead(body, 7000)}${projectBriefBlock(resp)}`;
        return envelope(ctx);
      }
      // 200 but no briefing for this project: still note the graph status.
      rlog(`briefing not found for ${slug} (${ncount} nodes)`);
      return envelope(
        `team graph: ${ncount} nodes @ ${host} (no standing briefing for ${slug} yet). ${USAGE_REMOTE}${qline}${oline}${projectBriefBlock(resp)}`
      );
    }

    // Non-200: fail open onto the cache. Distinguish AUTH failure from
    // TRANSPORT failure (issue-cc-auth-transport-conflation-silent-loss): a
    // 401/403 is not an outage — the token is revoked, expired, or mis-pasted,
    // and re-POSTing it never recovers (the distiller's outbox dead-letters it,
    // drain-outbox.js). Surfacing it as the same generic "OFFLINE" banner hides
    // the one fact the user can act on, and silently strands every captured
    // node. So name the cause and the fix loudly instead of blaming the host.
    // Fail-open is preserved: we still inject the cache (or nothing) and exit 0.
    const isAuth = brief.http === "401" || brief.http === "403";
    if (isAuth) {
      rlog(`auth failure (http=${brief.http}); token invalid/revoked — surfacing, falling back to cache`);
    } else {
      rlog(`server unreachable (http=${brief.http}); falling back to cache`);
    }
    const statusLine = isAuth
      ? `team graph: AUTH FAILED (${host} rejected the token, http ${brief.http}) — your spor token is invalid, revoked, or expired. Re-mint it and update SPOR_TOKEN; until then captures are NOT shipping (they spool to the outbox and dead-letter).`
      : `team graph: OFFLINE (could not reach ${host}).`;
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
      const ctx = `${statusLine} Showing cached briefing fetched ${fetched || "unknown"} — it may be stale.

## Standing project briefing (brief-${slug}, cached from the team graph)

${body}`;
      return envelope(ctx);
    }
    // No cache: still surface an auth failure (it is actionable and not an
    // outage); a pure transport failure with no cache injects nothing, as before.
    if (isAuth) {
      rlog("no cache available; surfacing auth failure only");
      return envelope(statusLine);
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
  // Repo identity (task-cc-project-identity-nodes): a resident `type: repo`
  // node (renamed from the former `type: project`,
  // dec-cc-repo-project-two-layer-identity) whose `slugs:` register (or id)
  // includes this session's slug widens matching to every alias it owns —
  // historical stamps stay as written and resolve at read time. One scan
  // collects both the per-file `project: X` stamp lines (the old grep) and the
  // repo identity nodes; with no repo node claiming the slug the alias set is
  // {slug} and behavior is byte-identical to the original.
  const stamps = []; // per file: the exact `project: ` stamp line values it carries
  const projects = []; // resident repo identity nodes: { id, slugs }
  for (const f of files) {
    try {
      const lines = fs.readFileSync(path.join(nodes, f), "utf8").split("\n");
      // The provenance stamp key is `repo:` (task-cc-repo-stamp-field-rename);
      // legacy `project:` stamps are still counted.
      stamps.push(lines.filter((l) => l.startsWith("repo: ") || l.startsWith("project: ")).map((l) => l.replace(/^(?:repo|project): /, "")));
      if (lines.includes("type: repo")) {
        const id = lines.find((l) => l.startsWith("id: "))?.slice(4).trim() ?? "";
        const m = lines.find((l) => l.startsWith("slugs:"))?.match(/\[([^\]]*)\]/);
        const status = lines.find((l) => l.startsWith("status:"))?.slice(7).trim() ?? "";
        projects.push({ id, slugs: (m?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean), status });
      }
    } catch {
      stamps.push([]);
    }
  }
  const owner = projects.find((p) => p.id === slug || p.slugs.includes(slug));
  const aliases = new Set([slug, ...(owner?.slugs ?? [])]);
  const projCount = stamps.filter((vals) => vals.some((v) => aliases.has(v))).length;

  // Archived repo (issue-cc-project-lifecycle-queue-pollution): a resident
  // `type: repo` node with `status: archived` retires it. Announce
  // it and skip the stale brief + the open-front line — the queue already
  // hides its items for everyone, so there's no live front to surface.
  if ((owner?.status || "").toLowerCase() === "archived") {
    return envelope(
      `A Spor knowledge graph is active: ${count} nodes in ${nodes}. Project ${owner.id} (${slug}) is ARCHIVED — its open work is retired and no longer surfaced in the queue. History stays reachable via /spor:brief; nothing to pick up here. ${USAGE_LOCAL}`
    );
  }

  // The in-process graph backs both the open-front line and the no-brief
  // fallback digest below — load it once, through the cached loader so a
  // re-load within this process is free and the scan latency gets a journal
  // stamp (issue-cc-local-mode-hook-load-latency). Fail open: a load failure
  // leaves both empty (the count line still prints).
  let g = null;
  try {
    const { graph: loaded, loadMs, cached } = u.loadGraphCached(nodes);
    g = loaded;
    u.journalLoadMs(graph, input.session_id, "session-start", loadMs, { nodes: count, cached });
  } catch {
    /* fail open */
  }

  // Open-front line: rank this project's queue in-process (no server, so heat
  // is 0 — the other QUEUE.md signals still order it) and surface the single
  // top item, mirroring remote mode's open-front line. Fail open: any error
  // (load/rank) leaves the line empty (issue-cc-local-mode-capture-queue-
  // surfacing-gap). Cheap: one already-loaded graph, limit 1.
  let oline = "";
  try {
    const { rankQueue } = require(path.join(u.ROOT, "lib", "queue.js"));
    const r = rankQueue(g, { project: slug, limit: 1 });
    const item = (r.items || [])[0];
    if (item && item.id) {
      // Plain user-facing phrasing — mirror remote mode's "next up:" line.
      oline = `\nnext up: ${item.id} — ${item.title || ""}${item.why ? ` (${item.why})` : ""}`;
      if (item.suggest === "close") oline += " — the queue suggests CLOSING it, not doing it";
      oline += ". Full queue: /spor:next.";
    }
  } catch {
    /* fail open */
  }

  let ctx = `A Spor knowledge graph is active: ${count} nodes in ${nodes} (${projCount} tagged repo: ${slug}). ${USAGE_LOCAL}${oline}`;

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
  } else if (g) {
    // No standing brief-<slug> node exists. Local mode has no distiller to
    // author one on the prompt path (no LLM there — that is the SessionEnd
    // distiller's job), so without this fallback solo users only ever saw the
    // node count, never the project briefing the README promises
    // (issue-cc-local-mode-briefing-creation-gap). Compile a project-scoped
    // digest on the spot from the already-loaded graph: pure tf-idf + graph
    // walk, no LLM, no write. The "query" is the project's own node titles
    // (the project's topic surface), so the digest seeds on the densest,
    // most-connected project nodes. It is clearly labelled auto-compiled and
    // NOT a standing briefing — running /spor:brief still produces the real
    // distilled artifact. Fail open: any error or an empty/irrelevant result
    // just leaves the count line.
    try {
      const compile = require(path.join(u.ROOT, "lib", "graph.js")).compile;
      const rp = (s) => g.projectAliases?.[s] ?? s;
      const key = rp(slug);
      const topics = Object.values(g.nodes)
        .filter((n) => n.type !== "briefing" && n.type !== "schema" && rp(n.project) === key)
        .map((n) => `${n.title ?? ""} ${n.summary ?? ""}`)
        .join(" ")
        .slice(0, 4000); // bounded query text; tf-idf ignores length beyond signal
      if (topics.trim()) {
        const r = compile(g, { query: topics, digest: true, project: slug });
        if (r.relevant && r.text) {
          // The digest's own header names the nodes dir and /spor:brief; keep
          // only its node list + corrections, under our own auto-compiled
          // heading so it reads as a stopgap, not the standing briefing.
          const lines = r.text.split("\n");
          const start = lines.findIndex((l) => l.startsWith("- **"));
          const digestBody = start >= 0 ? lines.slice(start).join("\n").trim() : "";
          if (digestBody) {
            ctx += `

## Project digest for ${slug} (auto-compiled on the fly from the local graph — no standing brief-${slug} node yet; run /spor:brief to author one)

${u.byteHead(digestBody, 7000)}`;
          }
        }
      }
    } catch {
      /* fail open */
    }
  }

  // Project grouping brief, local mode (task-cc-grouping-brief-digest-reads): if
  // this repo is grouped-under a `type: project` grouping that has its own
  // brief-<grouping> node on disk, inject it alongside the repo brief so solo
  // sessions get the same product-level context remote mode returns. Fail open;
  // graphs without a grouping brief are byte-identical to before.
  try {
    if (g) {
      const repoKey = g.projectAliases?.[slug] ?? slug;
      const gr = g.groupingRepos || {};
      let groupingId = gr[repoKey] ? repoKey : null;
      if (!groupingId) for (const [gid, set] of Object.entries(gr)) if (set.has(repoKey)) { groupingId = gid; break; }
      if (groupingId) {
        const pbFile = path.join(nodes, `brief-${groupingId}.md`);
        if (fs.existsSync(pbFile)) {
          const raw = fs.readFileSync(pbFile, "utf8");
          const pbody = nodeBody(raw);
          const pver = raw.match(/^version: *(.*)$/m)?.[1] ?? "";
          if (pbody) {
            ctx += `

## Standing PRODUCT briefing (brief-${groupingId} v${pver || "1"}, the grouping above brief-${slug} — context spanning every repo in the product)

${pbody}`;
          }
        }
      }
    }
  } catch {
    /* fail open */
  }

  // Ensure this repo has a durable identity node once it actually has content
  // in the graph (issue-spor-onboard-no-repo-identity-node). Mirrors the
  // server's learnFingerprints in remote mode: a backfilled/distilled repo with
  // no `type: repo` node yet gets one registered from its git fingerprints, so
  // it is a first-class node — the anchor for a grouped-under home and for
  // rename-healing. Gated on projCount>0 (real graph content), no owning repo
  // node yet, and fingerprints present, so a session in some unrelated checkout
  // never spawns an identity node. Ungrouped by default; the grouping suggester
  // proposes the home. Pure side effect, written AFTER the briefing is built so
  // it never alters this run's output; fail-open — never blocks session-start.
  try {
    const fp = cwd && fs.existsSync(cwd) ? u.repoFingerprints(cwd) : [];
    const repoFile = path.join(nodes, `repo-${slug}.md`);
    if (!owner && projCount > 0 && fp.length && /^[a-z0-9][a-z0-9-]*$/.test(slug) && !fs.existsSync(repoFile)) {
      fs.writeFileSync(repoFile, repoNodeMarkdown(slug, fp, new Date().toISOString().slice(0, 10)));
    }
  } catch {
    /* best effort — never block session-start */
  }

  return envelope(ctx);
}

module.exports = { sessionStart };
