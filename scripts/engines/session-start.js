"use strict";
// SessionStart engine: inject the standing project briefing plus a one-line
// status. Node port of session-start.sh — LOCAL mode is byte-identical to the
// original pure-file-read behavior; REMOTE mode keeps the same budgets
// (drain 2s/1 file, briefing 6s, queue 3s), cache format, and fail-open
// fallbacks. Returns the Claude-shaped envelope object, or null for no output.

const fs = require("fs");
const path = require("path");
const u = require("./util");

// The /spor:spor preload instruction LEADS every usage string (and so every
// session-start envelope, all modes): Spor's CLI syntax, node/edge format, and
// MCP/REST surface aren't in the model's training, so any graph operation
// attempted without first loading the skill tends to invent syntax. Stating it
// as a standing precondition here is cheaper than the agent rediscovering it
// per session. Phrased as "before any operation on the graph" to match the
// skill's own trigger.
const USAGE =
  "Before any operation on the Spor graph (searching/querying, reading or writing nodes, adding edges, capturing, or running spor CLI/MCP tools), load the /spor:spor skill first — it carries the CLI syntax, node/edge format, and tool surface your training doesn't cover. Use /spor:brief <query or node-id> for a task-specific briefing, /spor:correct to fix a bad briefing.";
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

// Path-scoped sub-briefs for monorepos (dec-spor-monorepo-path-scoped-briefs).
// A repo's .spor.json may carry a `briefs` map of relative-subtree-path ->
// brief-id (e.g. {"auth/": "brief-spor-server-auth", "hosting/": "..."}); a
// monorepo declares one brief per separately-deployable subtree without a third
// identity type below `repo` — the subtree is an "area", a label on a brief.
// session-start routes to the NEAREST-ANCESTOR area for cwd and surfaces the
// SIBLING areas as a discovery line, so a session deep in one subtree gets that
// area's brief while still learning the others exist — without injecting every
// body. Returns the block to splice onto the briefing context, or "" when no
// `briefs` map is configured (byte-identical, norm-cc-byte-identical-refactor)
// or on any error (fail-open).
//
// The active area's body is injected only when its brief is a node file on disk
// (local mode — a cheap read, the same source the repo brief is read from); in
// remote mode (no local node files) it degrades to a /spor:brief pointer, the
// same on-demand pull any brief takes there, so this needs no server work.
function pathScopedBriefsBlock(cwd, nodesDir) {
  try {
    const cfg = u.config();
    const briefs = cfg ? cfg.briefs() : null;
    if (!briefs || !Object.keys(briefs).length) return "";
    // Anchor the relative subtree paths to the repo-root manifest's directory
    // (the nearest-ancestor .spor.json that carried `briefs`). Fall back to the
    // git toplevel of cwd — the PHYSICAL checkout root, not inferenceRoot, which
    // collapses a linked worktree onto its main checkout — then to cwd itself.
    const base =
      (cfg && cfg.briefsBase()) ||
      (u.git(cwd, ["rev-parse", "--show-toplevel"]) || "").trim() ||
      cwd;
    const { active, siblings } = u.matchBriefs(briefs, base, cwd);
    let block = "";
    if (active) {
      let body = "";
      try {
        const f = path.join(nodesDir, `${active.id}.md`);
        if (fs.existsSync(f)) body = nodeBody(fs.readFileSync(f, "utf8"));
      } catch {
        /* fall through to the pointer line */
      }
      if (body) {
        block += `

## Active area briefing (${active.id}, covering ${active.area}/ — the sub-brief for the subtree you're working in, alongside the repo brief above)

${body}`;
      } else {
        block += `\n\nActive area for this subtree: ${active.area} — load its briefing with /spor:brief ${active.id}.`;
      }
    }
    if (siblings.length) {
      const list = siblings.map((s) => `${s.area} (${s.id})`).join(", ");
      const lead = active ? "This repo also has path-scoped briefs" : "This repo has path-scoped briefs";
      block += `\n\n${lead}: ${list} — open one with /spor:brief <id>.`;
    }
    return block;
  } catch {
    return "";
  }
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

// Spool depth at which an undelivered outbox is worth a nudge. A handful of
// files between a distill spool and the next drain is normal; this many means
// shipping has been failing long enough to flag (task-cc-client-hook-
// operability-diagnostics piece 2).
const SPOOL_NUDGE_THRESHOLD = 10;

// One-line client-degradation nudge, injected in the SAME channel as the
// OFFLINE/AUTH banner (task-cc-client-hook-operability-diagnostics piece 2).
// The fail-open machinery hides degradation: dead-lettered captures sit unseen
// in outbox/dead/ and a deep spool means captures aren't shipping. Surface it
// so the developer knows to look — and where (`spor-hook doctor`). Dead-letters
// win over spool depth (a permanent reject is the more actionable failure).
// Leading space + trailing period so it splices cleanly after a status line.
// Returns "" when healthy; fail-open — any error yields no nudge.
function degradationNudge(graph) {
  try {
    const outbox = path.join(graph, "outbox");
    const dead = u.spoolStats(path.join(outbox, "dead")).count;
    if (dead > 0) {
      return ` ⚠ ${dead} capture${dead === 1 ? "" : "s"} dead-lettered in outbox/dead/ (permanent rejects, usually a bad/expired token) — run 'spor-hook doctor'.`;
    }
    const spooled = u.spoolStats(outbox).count;
    if (spooled >= SPOOL_NUDGE_THRESHOLD) {
      return ` ⚠ ${spooled} captures spooled and undelivered (the server may have been unreachable) — run 'spor-hook doctor'.`;
    }
  } catch {
    /* fail open — a degraded health surface must never cost the session */
  }
  return "";
}

// Auto-publish this box's dispatch capabilities to the fleet scheduler
// (task-spor-fleet-capabilities-autopublish-session-start), the client half that
// makes the remote fleet scheduler (task-spor-remote-fleet-scheduler) live: the
// server host-matches an assigned `type: profile` against every box's published
// capabilities, so until boxes publish there is nothing to match. Folding the
// publish into session-start — beside the dispatch.repos / dispatch.capabilities
// self-registration above — auto-populates the fleet view and keeps each box's
// last-contact freshness current, no manual `spor capabilities publish` needed.
//
// REMOTE mode only (caller-gated) and only when a `dispatch.agent` is configured
// (`spor agent use`), so a box that hasn't opted into being a dispatch identity
// never publishes — the same key the manual verb publishes under. The pushed body
// is the SAME effectiveCapabilities() collapse the manual verb and local dispatch
// read, with THIS run's freshly-probed sets merged over the (pre-probe) in-memory
// config so we publish exactly what the probe just wrote. Fail-open and bounded
// (default 3s, like the claim heartbeat's curls); the caller runs it CONCURRENTLY
// with the briefing/queue reads so it adds nothing to the session-start critical
// path. Opt out with SPOR_CAPABILITIES_PUBLISH=0 (dispatch.capabilitiesPublish:
// false). Always returns null — it never alters this run's output.
async function publishCapabilities(probed, rlog) {
  try {
    const cfg = u.config();
    // Opt-out lever, resolved through the cascade with the env dual-read fallback
    // (mirrors claimNudge.enabled / SPOR_CLAIM_NUDGE).
    if (cfg ? !cfg.getBool("dispatch.capabilitiesPublish", true) : (u.envDual("CAPABILITIES_PUBLISH") ?? "1") === "0") return null;
    const agent = cfg ? cfg.get("dispatch.agent", null) : u.envDual("DISPATCH_AGENT") || null;
    if (!agent) return null; // no dispatch identity on this box — nothing to publish
    const sat = require(path.join(u.ROOT, "lib", "kernel", "satisfiability.js"));
    // Merge THIS run's fresh probe over the in-memory config (loaded before the
    // probe wrote) so the published set matches what `spor capabilities` reports.
    const rawCap = (cfg ? cfg.get("dispatch.capabilities", {}) : {}) || {};
    const eff = sat.effectiveCapabilities(probed ? { ...rawCap, probed } : rawCap);
    const timeoutMs = u.cfgNum("dispatch.capabilitiesPublishTimeoutMs", "CAPABILITIES_PUBLISH_TIMEOUT", 3000);
    const r = await u.curl(`${u.serverBase()}/v1/agents/${encodeURIComponent(agent)}/capabilities`, {
      method: "POST",
      headers: { ...u.bearer(), "content-type": "application/json" },
      body: JSON.stringify(eff),
      timeoutMs,
    });
    if (r.http === "200") {
      rlog(
        `capabilities published for ${agent} (harnesses=${eff.harnesses.length} mcp=${eff.reachable_mcp.length} skills=${eff.skills.length} plugins=${eff.plugins.length})`
      );
    } else {
      // Fail-open: a 4xx (no such agent / not owned / surface undeployed) or a
      // dead/slow server (http 000) never blocks the session; next start retries.
      rlog(`capabilities publish skipped (http=${r.http})`);
    }
  } catch {
    /* fail open — auto-publish must never cost the session */
  }
  return null;
}

async function sessionStart(input) {
  const graph = u.graphHome();
  const nodes = path.join(graph, "nodes");
  const cwd = input.cwd ?? "";
  const slug = u.projectSlug(cwd);

  // Shared graph home (issue-cc-local-mode-graph-sharing-gap,
  // dec-spor-local-mode-sharing-boundary): when this repo's `.spor` marker bound
  // a per-repo graph via `graph:` (local mode only), ensure the home carries a
  // .gitignore so the machine-local/ephemeral state we are about to write into
  // it (cache/, journal/, config.json, …) never rides the SHARED graph's git
  // flow. sharedGraphHome() is null in remote mode and for a personal ~/.spor,
  // so those are untouched. Idempotent + fail-open; runs before the writes below.
  try {
    const shared = u.config()?.sharedGraphHome?.();
    if (shared) u.ensureGraphGitignore(shared);
  } catch {
    /* best effort */
  }

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

  // Learn where this slug lives on THIS machine (slug -> checkout path), so
  // `spor dispatch` can later launch `claude --bg` in the right repo without a
  // path map in the shared graph (paths differ per teammate; repo nodes carry
  // slugs/fingerprints, never a local path). inferenceRoot() is the same repo
  // root projectSlug() derives the slug from, so path and slug stay consistent
  // and a linked worktree resolves to its main checkout. Pure side effect: never
  // alters this run's output; fail-open (registerRepo no-ops on a non-canonical
  // slug or unchanged value). (task-spor-cli-dispatch-background-agents)
  // The slug->path map is machine-local — written to the PERSONAL user config
  // home, never the (possibly marker-shared) graph home, so it can't desync
  // from where the cascade reads it back (issue-spor-config-desync-shared-graph-home).
  try {
    if (cwd && fs.existsSync(cwd)) {
      u.registerRepo(u.userConfigHome(), slug, u.inferenceRoot(cwd) || cwd);
    }
  } catch {
    /* best effort */
  }

  // Refresh this machine's dispatch CAPABILITIES (harnesses on PATH, installed
  // plugins/skills) into the same machine-local config.json — the other half of
  // profile satisfiability (dec-spor-machine-profile-satisfiability,
  // task-spor-dispatch-capabilities-satisfiability). Like registerRepo: a pure,
  // fail-open side effect that never alters this run's output, cheap and no-spawn
  // (PATH stat + a JSON read), so it stays off the latency budget. It writes only
  // `dispatch.capabilities.probed`; user declarations under `.declared` survive.
  // When a Spor server/connector is bound (remote mode), it also seeds
  // `reachable_mcp: [spor]` deterministically — the spor MCP is reachable by
  // construction in a dispatched session, so an `mcp: [spor]` profile satisfies on
  // a fresh box with no manual allow-mcp (task-spor-mcp-reachability-deterministic-seed).
  // The returned fresh probe is what the REMOTE-mode auto-publish below pushes to
  // the fleet scheduler (the in-memory config predates this run's probe write).
  let probedCaps = null;
  try {
    probedCaps = u.probeCapabilities(u.userConfigHome(), { sporReachable: !!u.serverBase() });
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

    // Client-degradation nudge (piece 2), computed once and spliced into every
    // status line below — it is orthogonal to whether THIS fetch succeeds (dead
    // letters from a past outage outlive a now-healthy server), so it rides the
    // healthy banner too, not only the OFFLINE/AUTH fallback.
    const dline = degradationNudge(graph);
    if (dline) rlog(`degradation nudge surfaced:${dline}`);

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
    // The fleet-capabilities auto-publish (task-spor-fleet-capabilities-autopublish-
    // session-start) rides this same concurrent batch: bounded (3s) and fail-open,
    // it overlaps the reads already on the critical path so it adds no latency. Its
    // result is ignored (publishCapabilities always resolves null); we still await
    // it here so the POST completes before the process exits.
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
      publishCapabilities(probedCaps, rlog),
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
        const ctx = `team graph: ${ncount} nodes @ ${host}.${dline} ${USAGE_REMOTE}${qline}${oline}

## Standing project briefing (brief-${slug} v${version}, machine-compiled from the team graph — correct it with /spor:correct, don't silently work around errors)

${u.byteHead(body, 7000)}${projectBriefBlock(resp)}${pathScopedBriefsBlock(cwd, nodes)}`;
        return envelope(ctx);
      }
      // 200 but no briefing for this project: still note the graph status.
      rlog(`briefing not found for ${slug} (${ncount} nodes)`);
      return envelope(
        `team graph: ${ncount} nodes @ ${host} (no standing briefing for ${slug} yet).${dline} ${USAGE_REMOTE}${qline}${oline}${projectBriefBlock(resp)}${pathScopedBriefsBlock(cwd, nodes)}`
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
    const statusLine =
      (isAuth
        ? `team graph: AUTH FAILED (${host} rejected the token, http ${brief.http}) — your spor token is invalid, revoked, or expired. Re-mint it and update SPOR_TOKEN; until then captures are NOT shipping (they spool to the outbox and dead-letter).`
        : `team graph: OFFLINE (could not reach ${host}).`) + dline;
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

${body}${pathScopedBriefsBlock(cwd, nodes)}`;
      return envelope(ctx);
    }
    // No cache: still surface an auth failure (it is actionable and not an
    // outage); a pure transport failure with no cache injects nothing, as before.
    if (isAuth) {
      rlog("no cache available; surfacing auth failure only");
      return envelope(statusLine);
    }
    // A pure transport failure with no cache normally injects nothing — but a
    // non-empty degradation nudge (dead letters / deep spool) is actionable
    // regardless of the current outage, so surface the OFFLINE banner + nudge
    // rather than swallowing the one fact the operator can act on (piece 2).
    if (dline) {
      rlog("no cache available; surfacing degradation nudge with OFFLINE banner");
      return envelope(statusLine);
    }
    rlog("no cache available; injecting nothing");
    return null;
  }

  // -------------------------------------------------------------------------
  // LOCAL MODE (original behavior — byte-identical to session-start.sh, except
  // the empty/absent-graph onboarding line below)
  // -------------------------------------------------------------------------
  let files = [];
  try {
    files = fs.readdirSync(nodes).filter((f) => f.endsWith(".md"));
  } catch {
    /* no nodes/ dir yet (fresh/onboarding home) or unreadable — count stays 0 */
  }
  const count = files.length;

  // Empty or absent local graph — the onboarding moment, e.g. right after
  // `spor dispatch --backfill` inits the home (it creates an empty nodes/ dir)
  // or a fresh `spor init`. Remote mode always emits a status line here ("no
  // standing briefing for <slug> yet"); local mode used to return null (no dir)
  // or claim "0 nodes active" (empty dir), so the SessionStart hook looked like
  // it never ran during onboarding — the parity gap reported when SessionStart
  // appeared dead for `claude --bg` (it fires; source=startup). Emit the parity
  // line so onboarding is visibly underway and points at the bootstrap path
  // (issue-cc-local-mode-session-start-empty-graph-fallback). Side effects above
  // (registerRepo, plugin-root) already ran; the repo-identity write below is
  // gated on projCount>0, so nothing else is skipped by returning early here.
  if (count === 0) {
    return envelope(
      `No Spor briefing for ${slug} yet — the local graph at ${nodes} is empty. ` +
        `Bootstrap this repo with /spor:backfill (or 'spor dispatch --backfill'); ` +
        `knowledge you capture lands here as you work. ${USAGE_LOCAL}`
    );
  }
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

  // Path-scoped sub-briefs (dec-spor-monorepo-path-scoped-briefs): route to the
  // active area for this subtree and surface the siblings. Appended last so it
  // nests below the repo + product briefs (product > repo > area). "" when the
  // repo declares no `briefs` map, so a markerless repo is byte-identical.
  ctx += pathScopedBriefsBlock(cwd, nodes);

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
