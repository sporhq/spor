"use strict";
// `spor dispatch` — plan, preview, guard, execute
// (task-spor-extract-dispatch-and-work-from-bin-spor).
//
// This was one 1,300-line function in bin/spor.js whose guards and side effects
// were interleaved, so every "refuse before any side effect" promise was a
// comment someone had to keep true by hand — and twice it was not
// (issue-spor-dispatch-probe-side-effect-before-refusal: a refused dispatch
// persisted a capability probe; the worktree self-heal rewrote dispatch.repos
// from a --print preview). It is now four phases with one rule between them:
//
//   planDispatch     resolve node → repo → target config → identity → profile →
//                    harness → posture → workspace, refusing the cheap guards on
//                    the way. READS ONLY: it may print, compile a briefing and
//                    read run records and config, and it never writes a file,
//                    the graph, or a lock. Whatever a later phase must persist
//                    (the corrected repo mapping, the fresh capability probe)
//                    rides the plan as data.
//   previewDispatch  `--print`: renders the plan. No I/O beyond stdout.
//   refuseDispatch   the real-run guards the preview only describes. The one
//                    consequence it may have is the FORK B refusal's own
//                    re-route (the autonomous tier writes an `assigned` edge),
//                    which is the refusal's outcome, not a launch's.
//   executeDispatch  the side effects, in the order the refusals inside it
//                    need: local lock → workspace/binary checks → token mint →
//                    local config → claim → workspace lock → worktree → launch.
//
// cmdDispatch composes them and is what bin/spor.js calls. Everything the phases
// need from the CLI (graph reads, briefing compile, worktree and launch helpers,
// stdout/stderr — err is the ERR_TEE-aware writer the work loop reads refusal
// reasons through) is INJECTED as `host`, so the module requires only lib code
// and a test can drive a plan against a fake host.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const remote = require(path.join(__dirname, "..", "remote.js"));
const { loadConfig } = require(path.join(__dirname, "..", "config.js"));
const u = require(path.join(__dirname, "..", "..", "scripts", "engines", "util.js"));
const sat = require(path.join(__dirname, "..", "kernel", "satisfiability.js"));
const preflight = require(path.join(__dirname, "preflight.js"));
const dispatchHarnesses = require(path.join(__dirname, "dispatch-harnesses.js"));
const dispatchRuns = require(path.join(__dirname, "agent-dispatch-runner.js"));

// The CLI helpers a dispatch needs, named so a missing one fails at
// construction rather than as a ReferenceError halfway through a launch.
const HOST_FUNCTIONS = Object.freeze([
  "err", "out", "acquireLocalDispatchLock", "agentIdGuess", "autoRouteToFleetHost",
  "badNodeIdReason", "claimDispatch", "compileBriefing", "createDispatchWorktree", "dirHostsSlug",
  "dispatchAgentId", "dispatchDeclineFindingCheck", "dispatchReadinessCheck",
  "dispatchResolutionReason", "dispatchWorktreeDir", "dispatchedAgents", "harnessReadOnlyPostures",
  "hasCmd", "isAgentId", "launchSupervisedHarness", "liveWorkspaceWriters", "mintAgentToken",
  "nodeUnreadable", "onboardRepo", "releaseLocalDispatchLock", "removeDispatchWorktree",
  "renderLaunchArg", "renderTemplate", "reportFleetHosts", "resolveDir", "resolveDispatchProfile",
  "resolveNode", "shellQuote", "targetRepoDispatchCfg", "topQueueItem", "worktreeName",
  "writeDispatchMcpConfig",
]);

function createDispatcher(host) {
  const missing = HOST_FUNCTIONS.filter((k) => typeof (host && host[k]) !== "function");
  if (missing.length) throw new Error(`createDispatcher: host is missing ${missing.join(", ")}`);
  const {
    err, out, acquireLocalDispatchLock, agentIdGuess, autoRouteToFleetHost, badNodeIdReason,
    claimDispatch, compileBriefing, createDispatchWorktree, dirHostsSlug, dispatchAgentId,
    dispatchDeclineFindingCheck, dispatchReadinessCheck, dispatchResolutionReason,
    dispatchWorktreeDir, dispatchedAgents, harnessReadOnlyPostures, hasCmd, isAgentId,
    launchSupervisedHarness, liveWorkspaceWriters, mintAgentToken, nodeUnreadable, onboardRepo,
    releaseLocalDispatchLock, removeDispatchWorktree, renderLaunchArg, renderTemplate,
    reportFleetHosts, resolveDir, resolveDispatchProfile, resolveNode, shellQuote,
    targetRepoDispatchCfg, topQueueItem, worktreeName, writeDispatchMcpConfig,
  } = host;

  // Resolve everything a dispatch needs and refuse the cheap guards. Returns an
  // exit code (a refusal, already reported) or the plan object.
  async function planDispatch(cfg, { values, positionals: pos }, ctx = null) {
    // The native `claude --bg` launch is retired (task-spor-deprecate-native-bg-
    // dispatch; see the launch-mode note further down). Refused FIRST, before
    // anything — repo registration, the capability probe's config write, a claim
    // — so an operator who passed it gets a clean no, not a half-run.
    if (values.bg) {
      err("cannot dispatch: 'spor dispatch --bg' (the native claude --bg launch) is retired — every dispatch now runs supervised, with its outcome read off its own stream.");
      err("  drop --bg (the run is followed by 'spor runs'); for an attachable interactive session, run 'claude --bg' yourself.");
      return 1;
    }
    const dryRun = !!(values.print || values["dry-run"]);
    const full = !!values.full;
    const noBrief = !!values["no-brief"];
    const noClaim = !!values["no-claim"];
    // The AUTONOMOUS tier of substitution-free re-routing (task-spor-fleet-
    // autoroute-auto-tier-consumer): on a FORK B refusal, hand the item to a fleet
    // host that satisfies THIS profile instead of stopping for a human to re-route.
    // Opt-in and explicit-wins, like the worktree flags — off, the refusal is
    // byte-identical to the human tier it extends.
    const autoRoute = values["no-auto-route"] ? false : !!(values["auto-route"] || cfg.getBool("dispatch.autoRoute", false));
    // The liveness bound on a re-route target. Generous on purpose: only an
    // agent SESSION heartbeats (the post-tool tick) or re-publishes (session
    // start), so a box sitting idle in `spor work` — exactly the box a handoff
    // wants — goes quiet without going away, and a tight window would escalate
    // past it. `0`/empty disables the filter (the server's own default).
    const autoRouteMaxAgeRaw = String(cfg.get("dispatch.autoRouteMaxAge", "24h") ?? "").trim();
    const autoRouteMaxAge = autoRouteMaxAgeRaw && autoRouteMaxAgeRaw !== "0" ? autoRouteMaxAgeRaw : null;
    const force = !!values.force;
    const backfill = !!values.backfill;
    const fromQueue = !!values["from-queue"];
    // An UNATTENDED launch — a `spor work` implementer, one of its gate fix
    // cycles, a rescue — has nobody to answer a permission prompt or to notice
    // two agents writing into one checkout. Set by dispatchThroughLocked beside
    // supervisedOnly/carryTask; a person's own `spor dispatch` never carries it,
    // which is what keeps the interactive single-run behavior unchanged
    // (task-spor-worker-preflight-validation).
    const unattended = !!(ctx && ctx.unattended);
    // A rescue that read the worker's foreign posture and translated it BY
    // MEANING to a genuinely attended one (no lane-declared unattended/read-only
    // narrowing applied — see rescuePassthrough) sets this: the caller has
    // already made the deliberate, non-widening choice this posture represents,
    // so preflight's unattended-write gate proceeds instead of refusing
    // (issue-spor-rescue-posture-attended-translation-hard-refuses). Nothing
    // else sets it — an ordinary worker with no posture at all still refuses.
    const allowAttended = !!(ctx && ctx.allowAttended);
    const dirOpt = values.dir || null;
    const model = values.model || null;
    let permMode = values["permission-mode"] || null;
    let sandbox = values.sandbox || null;
    const readOnly = !!values["read-only"];
    const approvalPolicy = values["approval-policy"] || null;
    const agent = values.agent || null; // claude --agent (harness agent DEFINITION)
    const asAgent = values.as || null; // Spor agent IDENTITY override for dispatch.agent
    // The escape hatch for dec-spor-worker-strictness-split-interactive-lenient:
    // by default a remote dispatch with no agent identity (below) hard-fails
    // rather than silently attributing agent writes to the person. This flag (or
    // its standing config twin) restores the old fail-soft, for solo/local use
    // where nobody has run `spor agent use` and that's fine.
    const allowPersonToken = !!values["allow-person-token"] || cfg.getBool("dispatch.allowPersonToken", false);
    // A user-supplied prompt template (task-spor-dispatch-user-prompt-templates):
    // --template wins, else a personal default in the config cascade
    // (dispatch.template — an absolute path, like dispatch.repos). Empty until we
    // resolve the file below, so an absent option leaves the prompt byte-identical.
    const templateOpt = values.template || cfg.get("dispatch.template", null);
    let nodeId = values.node || null;
    let targetSlug = values.slug || null;
    let itemRepo = null;
    let itemCommits = null;
    let name = values.name || null;
    let profileFlag = values.profile || null;
    let dispatchNodeRaw = null; // the dispatched node's markdown — read for its assigned->agent profile

    // Positional task text: parseArgs already split flags from positionals.
    let taskText = pos.join(" ").trim();

    // Load the template now (before any briefing compile) so a bad path fails fast.
    let template = null;
    if (templateOpt) {
      try {
        template = fs.readFileSync(path.resolve(templateOpt), "utf8");
      } catch (e) {
        err(`could not read --template ${templateOpt}: ${e.message}`);
        return 1;
      }
    }

    let brief = "";
    let instruction = "";
    let nodeTitle = "";
    let nodeSummary = "";
    let nodeType = "";
    let nodeStatus = "";
    let nodeDate = "";
    let resolvedReason = null; // set in node mode when the target is already resolved
    let readinessCheck = null; // set in node mode: {readiness, reasons} — the agent-readiness guard
    let declineFinding = null; // set in node mode: a live find-declined-* finding on the target

    if (fromQueue) {
      const top = await topQueueItem(cfg, targetSlug);
      if (!top || !top.id) {
        err("queue empty — nothing to dispatch");
        return 1;
      }
      nodeId = top.id;
      targetSlug = targetSlug || top.repo || top.project || null;
      // Auto-route by the item's own `profile:` frontmatter (task-spor-test-
      // change-lane-auto-routing) — the same one-line fallback `spor work`'s
      // dispatchWorkItem applies, so `--from-queue`'s "pick the top item and
      // dispatch it" doesn't quietly skip profile resolution for an item with
      // no `assigned -> agent` edge (resolveDispatchProfile finds nothing to
      // resolve without one). An explicit --profile still wins.
      if (!profileFlag && top.profile) profileFlag = top.profile;
    }

    if (backfill) {
      // Onboarding a (possibly thin) repo: dispatch the skill; no briefing to compile.
      instruction = taskText ? `/spor:backfill\n\n${taskText}` : "/spor:backfill";
      name = name || "spor-backfill";
    } else if (!nodeId && pos.length === 1 && /^[a-z0-9]+(-[a-z0-9]+)+$/.test(pos[0])) {
      // Auto-detect: a single hyphenated token that resolves to a node => node
      // mode. An unreadable read (a 2xx the server actually answered, just with
      // a body that failed to parse) is NOT the same as a confirmed 404 — it
      // must still route into node mode so the guard below refuses the dispatch
      // outright, rather than silently falling through to free-text mode and
      // skipping every resolved/readiness guard entirely on what is quite
      // possibly a real, already-finished work item
      // (issue-spor-resolve-node-unguarded-json-reads-null-as-unknown).
      const maybe = await resolveNode(cfg, pos[0]);
      if (maybe) {
        nodeId = maybe.id;
        taskText = "";
      }
    }

    if (!backfill && nodeId) {
      // `nodeId` may still be the raw, unchecked `--node <id>` flag value at
      // this point (`--from-queue`'s top.id and the auto-detect branch above
      // are already graph-sourced/regex-checked) — refuse a non-canonical id
      // here, before it ever reaches resolveNode's local-mode
      // `nodes/<id>.md` read, closing the gap `../x` could otherwise use to
      // pull an outside file into a dispatch prompt
      // (issue-spor-node-id-guard-remaining-read-paths).
      const bad = badNodeIdReason(nodeId);
      if (bad) {
        err(bad);
        return 1;
      }
      const node = await resolveNode(cfg, nodeId);
      if (!node) {
        err(`no such node: ${nodeId}`);
        return 1;
      }
      // A malformed 2xx body is a FAILED verification, not a readable-but-empty
      // node — dispatching against it would run dispatchResolutionReason /
      // dispatchReadinessCheck on frontmatter that never actually loaded, which
      // could silently wave through a dispatch this same guard exists to refuse
      // (issue-spor-resolve-node-unguarded-json-reads-null-as-unknown). Refuse
      // loudly instead of guessing.
      if (nodeUnreadable(node)) {
        err(`could not verify ${nodeId} — the graph's response body could not be read; try again`);
        return 1;
      }
      dispatchNodeRaw = node.raw || null;
      // The ITEM's own repo stamp, kept apart from `targetSlug`. They usually
      // agree, but `--slug` deliberately overrides the launch target for a
      // cross-repo dispatch, and the no-code-outcome check needs the value the
      // ITEM carried (WORKERS.md §10.11): comparing the item's current stamp
      // against a launch target it never had reads as a re-stamp that never
      // happened.
      itemRepo = node.repo || null;
      // The ITEM's own `commits:` stamps AS CLAIMED (task-spor-factory-skip-
      // resolved-items-with-empty-diff): the stale-premise check needs the
      // BEFORE-this-run value, exactly as item_repo does above — a run with
      // graph-write access could otherwise append its own already-landed sha to
      // `commits:` on its own item and manufacture the "predates the run"
      // evidence the check exists to require. Reading the node's CURRENT
      // `commits:` instead would trust exactly that write.
      itemCommits = Array.isArray(node.commits) ? node.commits : [];
      targetSlug = targetSlug || node.repo || null;
      nodeTitle = node.title || "";
      nodeSummary = node.summary || "";
      nodeType = node.type || "";
      nodeStatus = node.status || "";
      nodeDate = node.date || "";
      resolvedReason = dispatchResolutionReason(cfg, node);
      readinessCheck = dispatchReadinessCheck(cfg, node);
      declineFinding = dispatchDeclineFindingCheck(cfg, node);
      if (!noBrief) brief = await compileBriefing(cfg, { nodeId, full, project: targetSlug });
      instruction = `Work on ${nodeId}${node.title ? ` — ${node.title}` : ""}. The compiled Spor briefing above is your standing context.${taskText ? ` ${taskText}` : ""}`;
      name = name || nodeId;
    } else if (!backfill) {
      if (!taskText) {
        err('usage: spor dispatch "<task>" | --node <id> | --from-queue | --backfill');
        return 1;
      }
      if (!noBrief) brief = await compileBriefing(cfg, { query: taskText, full, project: targetSlug });
      instruction = taskText;
      name = name || taskText.split(/\s+/).slice(0, 8).join(" ").slice(0, 60);
    }

    const res = resolveDir(cfg, { dir: dirOpt, slug: targetSlug });
    if (!res.dir) {
      err(`don't know where '${res.slug}' lives on this machine.`);
      err(`  run 'spor dispatch' from inside that repo once (it self-registers), then re-run, or:`);
      err(`  spor repos add ${res.slug} <path>`);
      err(`  or pass --dir <path>.`);
      return 1;
    }
    if (!fs.existsSync(res.dir)) {
      err(`target dir does not exist: ${res.dir}`);
      return 1;
    }
    // Guard against a resolved dir that is ITSELF sitting inside a linked git
    // worktree (issue-spor-dispatch-dir-inside-worktree-nesting). Worktree
    // isolation cuts the AGENT's own worktree under res.dir
    // (dispatchWorktreeDir = res.dir/.claude/worktrees/<name>), so a res.dir that
    // is already a linked worktree would nest one worktree inside another. The
    // "cwd"/"cwd-self" sources already resolve through dispatchRoot()
    // (inferenceRoot), so they can never trip this — only an explicit --dir or a
    // dispatch.repos config entry can name a worktree path directly.
    // linkedWorktreeMainRoot() (unlike inferenceRoot()) doesn't also flag an
    // ordinary subdirectory of a main checkout, so this never fires on a
    // legitimate monorepo-subtree mapping.
    const worktreeMainRoot = u.linkedWorktreeMainRoot(res.dir);
    if (worktreeMainRoot) {
      if (res.source === "--dir") {
        err(`--dir ${res.dir} is inside a linked git worktree of ${worktreeMainRoot}.`);
        if (!force) {
          err(`  dispatch cuts its own worktree under the target dir, so nesting one inside another is refused.`);
          err(`  pass the main checkout instead: --dir ${worktreeMainRoot}`);
          err(`  re-run with --force to dispatch into the linked worktree anyway.`);
          return 1;
        }
        err(`  --force set — dispatching into the linked worktree anyway.`);
      } else if (res.source === "config") {
        // A machine-local mapping has no business naming an ephemeral worktree —
        // self-heal it the same way a "cwd" dispatch's own resolution never lets
        // this happen in the first place. The corrected dir is PLANNED here and
        // persisted by the execute phase's self-registration (which writes
        // exactly res.dir), so a --print preview or a refused dispatch leaves
        // dispatch.repos as it found it.
        err(`note: dispatch.repos['${res.slug}'] pointed inside a linked worktree (${res.dir}); correcting to the main checkout ${worktreeMainRoot}.`);
        res.dir = worktreeMainRoot;
      }
    }
    // Guard a CORRUPT dispatch.repos mapping (issue-spor-dispatch-repos-corruption-
    // worktree-session-start). The slug->path map is machine-local and a
    // session-start re-probe from a confused worktree cwd could have pointed this
    // slug at the WRONG checkout (e.g. spor-server -> the client repo), so the
    // agent would run against a tree that lacks the node's files and "complete"
    // with zero commits. Only the map-resolved branch is suspect (source "config")
    // — an explicit --dir or a cwd resolution is the caller's own pin and is
    // trusted. We can only authoritatively name a checkout's identity when it IS a
    // git work tree (`--is-inside-work-tree` prints the literal "true"/"false", so
    // match the string — a bare repo prints "false" with exit 0); a non-git target
    // has no authoritative slug, so we trust the map there (and `spor repos add` to
    // an arbitrary path stays valid). dirHostsSlug() accepts both the checkout's
    // own root slug AND a monorepo subtree marker that legitimately pins the slug
    // (my-api -> the shared root), so only a genuine cross-repo mismatch trips the
    // guard: refuse loudly with remediation. --force overrides.
    const dirIsWorkTree = (u.git(res.dir, ["rev-parse", "--is-inside-work-tree"]) || "").trim() === "true";
    if (res.source === "config" && dirIsWorkTree && !dirHostsSlug(res.dir, res.slug)) {
      err(`dispatch.repos['${res.slug}'] points at ${res.dir}, but that checkout is '${u.projectSlug(res.dir)}', not '${res.slug}' (and hosts no '${res.slug}' subtree).`);
      if (!force) {
        err(`  the slug→path map is corrupt (likely a session-start re-probe from a worktree cwd); dispatching there`);
        err(`  would run ${nodeId || name} against the wrong repo. Fix it with 'spor repos add ${res.slug} <correct-path>'`);
        err(`  (or add a '.spor' marker pinning 'repo: ${res.slug}' to that checkout), or pass --dir <path>.`);
        err(`  re-run with --force to dispatch into the mismatched checkout anyway.`);
        return 1;
      }
      err(`  --force set — dispatching into the mismatched checkout anyway.`);
    }
    // A node / --from-queue dispatch targets a SPECIFIC node that belongs to a
    // SPECIFIC repo, and the agent must run in THAT repo so its workspace hooks
    // apply — not the launcher's (issue-spor-dispatch-from-queue-wrong-repo-hooks).
    // The happy path resolves the target repo from the node's repo/project stamp
    // through the dispatch.repos map (res.source "config"), and an unknown stamp
    // already errors loudly above (res.dir null). The remaining hole is a node that
    // carries NO repo/project stamp: targetSlug stays null, so resolveDir silently
    // falls back to the launcher's cwd (res.source "cwd") and the launcher's hooks
    // would run against another repo's work. Refuse it loudly here, mirroring the
    // unknown-slug error, rather than mis-targeting in silence. An explicit --dir/
    // --slug moves res.source off "cwd" (the caller pinned it on purpose), and
    // free-text / --backfill dispatch legitimately targets the cwd (no nodeId), so
    // both keep working — only a stampless node-mode dispatch is caught.
    if (nodeId && !backfill && res.source === "cwd") {
      err(`can't tell which repo ${nodeId} belongs to — it carries no repo/project stamp,`);
      err(`  so dispatch would fall back to the launcher's cwd (${res.dir}) and apply ITS`);
      err(`  workspace hooks to another repo's work. Pin the target explicitly:`);
      err(`  pass --dir <path> (use --dir . if ${nodeId} really is for this repo),`);
      err(`  or --slug <repo> with 'spor repos add <repo> <path>', or add a repo:/project: stamp to ${nodeId}.`);
      return 1;
    }

    // Worktree isolation. Run the agent in its own worktree off res.dir so parallel
    // dispatches never collide on the shared tree/index. Resolution, highest wins:
    //   --no-worktree > --worktree > TARGET repo .spor.json dispatch.worktree >
    //   standing cfg dispatch.worktree > off.
    // The TARGET repo's own .spor.json wins over the standing user/global config so
    // a repo that declares it wants isolation is honored wherever it's dispatched
    // FROM. Forced off for --backfill, which sets up the MAIN checkout itself. The
    // setup hook follows the same target-first precedence; relative paths in the
    // marker resolve against the repo (the spor-server hook stages the
    // node_modules symlink + $SPOR_LIB the bare worktree needs).
    //
    // The "standing cfg" fallback must NOT be `cfg` as-is: `cfg` is anchored at
    // the DISPATCHER's cwd (process.cwd()), so its repo-.spor.json layer is the
    // LAUNCHER's own repo config, not the target's. Cross-repo dispatch (launch
    // from repo A for a node targeting repo B) would then apply repo A's
    // dispatch.worktreeSetup — a path relative to A — inside B's fresh worktree,
    // where it doesn't exist (issue-spor-dispatch-worktree-setup-wrong-repo-
    // config). Re-resolving the cascade anchored at res.dir instead fixes this:
    // it still picks up target's own .spor.json (redundant with targetCfg above,
    // but harmless) and the location-independent user/global config layers, while
    // never seeing a foreign repo's .spor.json.
    const targetCfg = targetRepoDispatchCfg(res.dir);
    const targetStandingCfg = loadConfig({ cwd: res.dir, env: cfg.env() });
    // `worktreeSetup` here is DIAGNOSTIC ONLY — the --print preview below and the
    // real run's declared-but-not-enabled warning (task-spor-worker-preflight-
    // validation) — read from the main checkout's live files since no worktree
    // exists yet to read it from, so both can be wrong in either direction if
    // that checkout's .spor.json is mid-edit. Neither the preview nor the warning
    // changes what runs. The RUNNING hook never comes from this value:
    // createDispatchWorktree re-resolves dispatch.worktreeSetup from the
    // freshly-created worktree's own checkout instead, so a stale/dirty main index
    // at dispatch time can't silently no-op the hook
    // (issue-spor-dispatch-worktree-config-live-file-race).
    const worktreeSetup =
      targetCfg.worktreeSetup != null ? targetCfg.worktreeSetup : targetStandingCfg.get("dispatch.worktreeSetup", null);
    const worktreeDefault =
      targetCfg.worktree != null ? targetCfg.worktree : !!targetStandingCfg.get("dispatch.worktree", false);
    const useWorktree =
      !backfill && (values["no-worktree"] ? false : !!(values.worktree || worktreeDefault));
    // Where this launch would actually write, decided once and read by the
    // --print preview, the concurrency guard and the acquisition below
    // (task-spor-worker-preflight-validation). `worktreeSetup` is deliberately
    // not an input to `useWorktree` above — a hook that says how to PREPARE an
    // isolated tree never says one is wanted — but a repo declaring the hook with
    // isolation off is the Dartlane pilot's second failure verbatim, so the plan
    // carries that mismatch (`setupOrphaned`) for the diagnostics to name.
    const workspacePlan = preflight.planWorkspace({
      repoDir: res.dir,
      worktreeDir: backfill ? null : dispatchWorktreeDir(res.dir, name),
      useWorktree,
      worktreeSetup,
      explicitNoWorktree: !!values["no-worktree"],
    });

    // Session project (issue-spor-dispatch-propagate-session-project-to-questions).
    // The agent token carries only {agent, session} — NOT the project — and a
    // launcher env is not a channel every harness honors
    // (dec-spor-session-identity-active-record). So the one channel the session
    // project rides to the agent in every launch mode is the prompt itself: state it, and
    // tell the agent to pass it as ask_question's `project` param when a question
    // has no clear `mentions:`. The server gives that explicit project precedence
    // over its mentions/neighborhood derivation, closing the residual mention-less,
    // no-match case that otherwise mis-stamps the question into the asker's home
    // project. res.slug is the project this dispatch resolved into (always set —
    // resolveDir falls back to the cwd slug). Omitted from a --template prompt,
    // which exposes the same value as {{slug}}/{{project}} and takes over entirely.
    const sessionNote = res.slug
      ? `> **Spor session project:** \`${res.slug}\`. If you file a question with ` +
        `\`ask_question\` (or \`POST /v1/questions\`) that has no clear \`mentions:\`, pass ` +
        `\`project: "${res.slug}"\` so it is stamped to this project rather than ` +
        `defaulting to the asker's home project.\n\n`
      : "";
    const defaultPrompt = brief
      ? `${sessionNote}# Spor briefing (compiled for this task — your standing context)\n\n${brief}\n\n---\n\n# Task\n\n${instruction}\n`
      : `${sessionNote}${instruction}`;

    // With no template the launched prompt adds only the session-project note above
    // (issue-spor-dispatch-propagate-session-project-to-questions). A template takes
    // over entirely: it decides where the compiled brief, the task, and the node
    // metadata land (or wraps the whole default via {{default}}).
    let prompt = defaultPrompt;
    if (template != null) {
      const r = renderTemplate(template, {
        brief, briefing: brief, neighbourhood: brief, neighborhood: brief,
        task: instruction, instruction,
        node: nodeId || "", node_id: nodeId || "", id: nodeId || "",
        title: nodeTitle,
        summary: nodeSummary, type: nodeType, status: nodeStatus, date: nodeDate,
        slug: res.slug || "", project: res.slug || "", repo: res.slug || "",
        dir: res.dir || "",
        default: defaultPrompt,
      });
      if (r.unknown.length) {
        err(
          `warning: unknown template placeholder(s): ${[...new Set(r.unknown)].join(", ")} ` +
            `(available: brief, task, node, id, title, summary, type, status, date, slug, dir, default)`
        );
      }
      prompt = r.text;
      // A WORKER's dispatch (ctx.carryTask — set by dispatchThrough beside
      // supervisedOnly) must reach the agent with its task text whatever the
      // template says: for `spor work` that text IS the worker contract, a fix
      // cycle's or a rescue's instructions, and the one-turn notice they all
      // carry (issue-spor-rescue-and-fix-sessions-end-turn-waiting-on-
      // background-job). `--template` rides the loop's passthrough and a
      // personal `dispatch.template` applies to every dispatch on the box, so a
      // template naming neither {{task}} nor {{default}} would silently launch
      // an unattended implementer with no contract at all — the bypass the
      // notice exists to close. A person's own `spor dispatch --template` keeps
      // the template's full authority (byte-identical); only a worker's launch
      // gets the task appended, and says so.
      if (ctx && ctx.carryTask && instruction && !prompt.includes(instruction)) {
        err(
          `warning: the prompt template omits {{task}} and {{default}}, so the worker's instructions (the contract and its` +
            ` one-turn notice) would not reach the agent — appending them after the rendered template`
        );
        prompt = `${prompt.replace(/\s+$/, "")}\n\n---\n\n# Task\n\n${instruction}\n`;
      }
    }

    // Same-machine duplicate-dispatch guard (task-spor-dispatch-same-machine-guard).
    // `spor dispatch` names each background agent after its node id, so an active
    // agent with this name means this person already has this node in flight on THIS
    // machine — a duplicate the auto-claim can't catch (a same-person re-claim is an
    // idempotent renew by design, dec-cc-task-claim-lease). dispatchedAgents() is the
    // same NO-LLM, fail-soft cross-reference `spor next --hide-dispatched` uses; node
    // mode only (mirrors the auto-claim's scope), in BOTH local and remote (it's a
    // local run-record read, independent of the graph backend). An unreadable
    // journal => empty => no guard (fail-open); --force overrides.
    const inFlight = nodeId && !backfill ? dispatchedAgents(cfg).get(name) || [] : [];

    // Session identity (dec-spor-dispatch-bg-session-late-bind). A supervised run
    // (`claude -p` stream-json, codex, …) announces its session on its own
    // stream, so we do NOT force one; the agent token is minted session-DEFERRED
    // and the supervisor binds the real session the moment the stream names it.
    // The run's own identity is the `run_id` its record is minted under at
    // launch — never a name+cwd match against a harness listing (the retired
    // native launch's heuristic, task-spor-deprecate-native-bg-dispatch).
    // SPOR_SESSION_ID only labels the --print preview. `mcpKey` names the 0600
    // --mcp-config file — a fresh uuid, since the session id isn't available here.
    const pinnedSession = process.env.SPOR_SESSION_ID || null;
    const mcpKey = crypto.randomUUID();
    // This machine's agent node — the WHO a dispatched session runs as. `--as`
    // overrides the per-machine dispatch.agent default for this one dispatch. The
    // id must satisfy the SAME contract the server's token-mint endpoint enforces
    // (an 'agent-<slug>' kebab id) — an EXPLICIT --as that doesn't is a hard error
    // here, caught before any side effect rather than as a per-dispatch 422
    // (issue-spor-dispatch-agent-id-prefix-validation-gap). Only meaningful remotely
    // (the server is the CA that mints the agent token); a local-mode dispatch or an
    // unconfigured machine simply runs person-scoped.
    if (asAgent && !isAgentId(asAgent)) {
      err(`invalid --as agent id '${asAgent}' — must be an 'agent-<slug>' kebab id (e.g. agent-your-machine)`);
      const guess = agentIdGuess(asAgent);
      if (guess) err(`  did you mean '--as ${guess}'?  ('spor agent list' shows the full id — the 'agent-' prefix is part of it, not the label)`);
      return 1;
    }
    let identityAgent = cfg.mode() === "remote" ? (asAgent || dispatchAgentId(cfg)) : null;
    // A configured `dispatch.agent` (no --as) that isn't a valid agent id — e.g. the
    // agent's LABEL stored instead of its 'agent-'-prefixed NODE id — would 422 at
    // token-mint (issue-spor-dispatch-agent-id-prefix-validation-gap). Catch it here
    // with an actionable line rather than a round-trip to a 422 that names nothing.
    // Per dec-spor-worker-strictness-split-interactive-lenient this now HARD-FAILS
    // on a real run — a dispatch that can't resolve an agent identity must not
    // silently attribute agent writes to the person — unless --allow-person-token
    // (or dispatch.allowPersonToken) opts back into the old fail-soft. --print stays
    // a preview regardless (never fails here; the preview line below still shows
    // "person-scoped"). The explicit --as path already hard-errored above, so this
    // only fires for the config default.
    if (identityAgent && !isAgentId(identityAgent)) {
      const guess = agentIdGuess(identityAgent);
      if (!dryRun && !allowPersonToken) {
        err(`cannot dispatch ${nodeId || name}: configured dispatch.agent '${identityAgent}' is not a valid agent id.`);
        err(`  agent ids start with 'agent-'.${guess ? ` fix: spor agent use ${guess}` : ""}  ('spor agent list' shows your agents.)`);
        err(`  pass --allow-person-token to dispatch person-scoped instead (dispatch.allowPersonToken to make it standing).`);
        return 1;
      }
      err(`warning: configured dispatch.agent '${identityAgent}' is not a valid agent id — dispatching person-scoped${allowPersonToken ? " (--allow-person-token)" : ""}.`);
      err(`  agent ids start with 'agent-'.${guess ? ` fix: spor agent use ${guess}` : ""}  ('spor agent list' shows your agents.)`);
      identityAgent = null;
    }
    // An explicit --as can't take effect in local mode — there is no CA to mint the
    // agent token. Say so rather than silently dropping it to person-scoped.
    if (asAgent && cfg.mode() !== "remote") {
      err(`note: --as ${asAgent} ignored in local mode — agent-on-behalf-of attribution is remote-only`);
    }
    // No agent identity to dispatch under at all (no --as, no dispatch.agent
    // configured) — the other half of the same hard-fail: a remote dispatch with
    // nothing to mint a token FOR is exactly as much a silent person-attribution
    // as a mint failure, so it gets the same escape hatch. Local mode has no CA to
    // mint against in the first place and stays byte-identical (never reaches here
    // with identityAgent unset — see above).
    if (!dryRun && cfg.mode() === "remote" && !identityAgent && !allowPersonToken) {
      err(`cannot dispatch ${nodeId || name}: no dispatch agent configured for this machine.`);
      err(`  fix: spor agent use <agent-id>  ('spor agent create <label>' first if you have none yet; 'spor agent list' shows them.)`);
      err(`  or pass --allow-person-token to dispatch person-scoped anyway (dispatch.allowPersonToken makes it standing).`);
      return 1;
    }

    // Agent-readiness guard inputs (task-spor-dispatch-readiness-guard): computed
    // once, read by both the --print preview and the real-run refusal/warn below.
    // `requires: human` (readinessRequiresHuman) is the hard-refuse subset of the
    // broader `readiness: human` classification (readinessHuman) — see the
    // real-run guard for the distinction. Derived purely from readinessCheck
    // (already resolved from the node above), so it costs nothing to evaluate
    // before profile resolution below.
    const readinessHuman = !!(readinessCheck && readinessCheck.readiness === "human");
    const readinessRequiresHuman = readinessHuman && readinessCheck.reasons.includes("requires human");

    // Refuse the cheap, node-derived guards BEFORE profile resolution on a REAL run
    // (issue-spor-dispatch-probe-side-effect-before-refusal): profile resolution
    // can cost graph reads, and a refusal the node alone decides shouldn't wait
    // on them. (It no longer persists anything either way — the fresh capability
    // probe rides the plan and executeDispatch writes it.) --print keeps the
    // upfront compute-everything shape (it needs the profile verdict to preview
    // every guard, this one included), so the early exit is real-run only; the
    // preview still resolves the profile and reports each guard's would-refuse
    // verdict for itself.
    if (!dryRun && resolvedReason && !force) {
      err(`${nodeId} is already resolved (${resolvedReason}) — not dispatching.`);
      err(`  re-run with --force to dispatch at it anyway, or pick another task with 'spor next'.`);
      return 1;
    }
    // A prior dispatch already declined this exact node — its premise was wrong,
    // not merely unfinished — and left the standing finding as a record. Refuse
    // rather than pay the same investigation again (task-spor-decline-finding-
    // gates-redispatch); --force overrides, same shape as the resolved guard
    // above. A finding a person has since resolved/dismissed already dropped out
    // of dispatchDeclineFindingCheck, so this can only fire on a still-live one.
    if (!dryRun && declineFinding && !force) {
      err(`${nodeId} carries a live decline finding (${declineFinding.id}) — a prior dispatch declined this item, not dispatching.`);
      err(`  ${declineFinding.summary || declineFinding.title || "see the finding for why the premise no longer holds"}`);
      err(`  re-run with --force to dispatch anyway, or resolve/dismiss ${declineFinding.id} first if the finding no longer holds.`);
      return 1;
    }
    if (!dryRun && readinessRequiresHuman) {
      err(`cannot dispatch ${nodeId || name}: this item requires a human — ${readinessCheck.reasons.join(", ")}.`);
      err(`  the assignment is unchanged. A human must do this work (or edit the node's 'requires:' list once`);
      err(`  it no longer needs one), then dispatch again — a readiness stamp alone can't override it.`);
      return 1;
    }

    // Profile satisfiability (dec-spor-machine-profile-satisfiability, FORK B).
    // Resolve the profile this dispatch runs under (--profile > the node's
    // assigned->agent profile attr > the agent's default) and decide whether THIS
    // machine can launch it. The verdict feeds the --print preview below and a
    // hard refusal before any side effect in the real run. No profile resolved =>
    // byte-identical to before (the common case until profiles are in use).
    // Never persisted here: the probe it takes comes back as profileCheck.probed
    // and only a dispatch that reaches its side effects writes it.
    const profileCheck = await resolveDispatchProfile(cfg, { profileFlag, nodeRaw: dispatchNodeRaw, identityAgent, persistProbe: false });
    if (profileCheck && profileCheck.found === false) {
      // Explicit --profile we couldn't load (absent locally, or unfetchable
      // remotely). Refuse rather than launch under an unverifiable profile.
      err(`could not load profile ${profileCheck.id} (from ${profileCheck.source}).`);
      err(`  check the id with 'spor get ${profileCheck.id}', or drop --profile.`);
      return 1;
    }
    const unsatisfiable = !!(profileCheck && profileCheck.verdict && !profileCheck.verdict.ok);
    const profileRuntime = (profileCheck && profileCheck.profile) || {};
    const harness = profileRuntime.harness || "claude-code";
    // A graph write must never define what a machine executes
    // (task-spor-dispatch-declarative-custom-harness). A profile selects a
    // harness by NAME; the command, argv, environment and report/session
    // recovery behind that name are bound machine-locally. A profile carrying
    // any of those is refused outright — in --print too, so a preview never
    // shows a launch the real run would reject.
    const graphLaunch = sat.graphLaunchFields(profileRuntime);
    if (graphLaunch.length) {
      err(`cannot dispatch ${nodeId || name}: profile ${profileCheck && profileCheck.id ? profileCheck.id : harness} declares ${graphLaunch.map((k) => `'${k}'`).join(", ")}.`);
      err(`  a graph write must never define what a machine executes — a profile names a harness, and this`);
      err(`  machine binds what that name runs ('${sat.DECLARED_HARNESS_CONFIG_KEY}.<id>' in $SPOR_HOME/config.json).`);
      err(`  remove ${graphLaunch.length > 1 ? "those fields" : "that field"} from the profile node; the assignment is unchanged.`);
      return 1;
    }
    // Built-in adapter first; failing that, this machine's own declaration for
    // the id. A declaration that exists but is unusable is reported as ITS OWN
    // error rather than as "unsupported harness" — the operator wrote something,
    // and needs to know what is wrong with it.
    const harnessResolution = dispatchHarnesses.resolveHarness(harness, { cfg });
    const harnessAdapter = harnessResolution.adapter;
    if (harnessResolution.error && !dryRun) {
      err(`cannot dispatch ${nodeId || name}: this machine's declaration for harness '${harness}' is unusable.`);
      err(`  ${harnessResolution.error}`);
      err(`  fix it in $SPOR_HOME/config.json; the assignment is unchanged.`);
      return 1;
    }
    // One launch mode (task-spor-deprecate-native-bg-dispatch): every harness,
    // Claude Code included, launches SUPERVISED — a child speaking a JSONL stream
    // under our own supervisor, whose record, report and terminal state come off
    // that stream (dec-spor-claude-code-supervised-by-default). The native
    // `claude --bg` opt-in is RETIRED: its outcome could only be inferred by
    // scraping `claude agents --json` and the harness's transcript JSONL, both of
    // which shifted with every Claude Code release. An explicit `--bg` is
    // refused at the top of this function (silently ignoring a flag the operator
    // passed is worse than saying no); a standing `dispatch.claudeLaunchMode: native-background` is ignored
    // with a warning, since failing every dispatch over a stale config key helps
    // nobody. A worker-loop dispatch (`ctx.supervisedOnly`) never warns here —
    // cmdWork says it once at worker start.
    const configuredLaunchMode = cfg.get("dispatch.claudeLaunchMode", null) || null;
    if (configuredLaunchMode && configuredLaunchMode !== "supervised" && !(ctx && ctx.supervisedOnly)) {
      err(configuredLaunchMode === "native-background"
        ? "warning: dispatch.claudeLaunchMode 'native-background' is retired (the native claude --bg launch) — ignoring it; this dispatch runs supervised. Remove the key to silence this."
        : `warning: dispatch.claudeLaunchMode '${configuredLaunchMode}' is not recognized (supervised is the only launch mode) — ignoring it.`);
    }
    const effectiveModel = model || profileRuntime.model || null;
    // Explicit-first launcher resolution (task-spor-dispatch-adapters-opencode-
    // copilot): the adapter consults its env override and `dispatch.bin.<harness>`
    // through the cascade before falling back to the bare name. With neither set
    // this is the same string it always returned.
    const harnessBin = harnessAdapter ? harnessAdapter.command(process.env, cfg) : null;
    // A BUILT-IN harness's launcher override is machine-local config, spawned
    // with cwd=launchDir exactly like a declared harness's `command` — refuse
    // the same relative-path shape here, before any worktree setup, rather than
    // letting it resolve against the dispatched repo's own worktree
    // (issue-spor-dispatch-bin-override-relative-path-execution). A declared
    // harness's own `command` never routes through this override (it reads
    // `dispatch.harness.<id>.command` directly, already checked in
    // normalizeHarnessDeclaration), so this is scoped to built-ins only.
    const harnessBinCheck =
      harnessAdapter && !harnessAdapter.declaration
        ? dispatchHarnesses.checkHarnessBinOverride(harnessAdapter.id, { env: process.env, cfg })
        : { ok: true };
    if (!harnessBinCheck.ok && !dryRun) {
      err(`cannot dispatch ${nodeId || name}: ${harnessBinCheck.error}.`);
      err(`  fix it in $SPOR_HOME/config.json (or its env override); the assignment is unchanged.`);
      return 1;
    }
    // --read-only (task-spor-review-gate-stateful-bounded): the posture a gate's
    // REVIEW dispatch runs under — it reads the implementer's live checkout, so
    // it must not be able to write to it. Expressed per harness by the adapter
    // (Codex's --sandbox read-only, Claude Code's plan permission mode); it
    // OVERRIDES an explicit --sandbox/--permission-mode from the caller (a
    // worker's passthrough may carry a write-capable posture for its
    // implementers — that must not leak into its reviewers), with a warning so
    // the override is visible. A harness with NO read-only posture is REFUSED,
    // not warned about (review finding 3 on the first cut: a warning left the
    // reviewer write-capable on exactly the harnesses that had no posture yet):
    // `--read-only` is a promise the caller relies on, and a launch that cannot
    // keep it must not proceed as if it had. Every built-in adapter declares a
    // posture; a custom harness must explicitly declare its fixed launcher
    // read-only before it can serve a review gate.
    if (readOnly && harnessAdapter) {
      const ro = harnessAdapter.readOnly || null;
      if (!ro) {
        err(`spor dispatch: --read-only cannot be enforced on ${harnessAdapter.label} — the harness declares no read-only posture, so the run would be write-capable.`);
        err(`  route the read-only run (a review gate's profile) to a harness that has one: ${harnessReadOnlyPostures()}.`);
        return 1;
      } else {
        if (ro.sandbox) {
          if (sandbox && sandbox !== ro.sandbox) err(`warning: --read-only overrides --sandbox ${sandbox} with --sandbox ${ro.sandbox}.`);
          sandbox = ro.sandbox;
          // A translated bypassPermissions would re-open the sandbox; the
          // explicit read-only posture wins over a passthrough bypass.
          if (permMode === "bypassPermissions") permMode = null;
        }
        if (ro.permissionMode) {
          if (permMode && permMode !== ro.permissionMode) err(`warning: --read-only overrides --permission-mode ${permMode} with --permission-mode ${ro.permissionMode}.`);
          permMode = ro.permissionMode;
        }
      }
    }
    // Validate BEFORE building any argv (preview or real) — a translated option
    // (today: Codex + --permission-mode bypassPermissions) changes what argv
    // buildArgs should see, so effectiveSandbox/effectiveApprovalPolicy below
    // must be resolved first and threaded through every buildArgs call site.
    const harnessOptionsCheck = harnessAdapter && harnessAdapter.validateOptions({
      permissionMode: permMode, agent, sandbox, approvalPolicy,
    });
    if (harnessOptionsCheck && harnessOptionsCheck.message) {
      err(harnessOptionsCheck.message);
      err(`  ${harnessOptionsCheck.hint}`);
      return 1;
    }
    if (harnessOptionsCheck && harnessOptionsCheck.warning) err(harnessOptionsCheck.warning);
    const translated = harnessOptionsCheck && harnessOptionsCheck.translate;
    const effectiveSandbox = (translated && translated.sandbox) || sandbox || "workspace-write";
    const effectiveApprovalPolicy = (translated && translated.approvalPolicy) || approvalPolicy || "never";
    // NB: no `--session-id` — the harness allocates and announces its own real
    // session on its supervised stream; we capture that post-launch instead of
    // forcing one (dec-spor-dispatch-bg-session-late-bind).
    // The adapter's own read-only posture rides into buildArgs only under
    // --read-only, so a plain dispatch's argv is byte-identical.
    const readOnlyPosture = readOnly && harnessAdapter ? harnessAdapter.readOnly || null : null;
    // --- worker preflight (task-spor-worker-preflight-validation) -------------
    // Two things the Dartlane pilot proved nothing checked before a claim: that
    // an unattended run can actually WRITE (fe24cc97 launched Claude Code with no
    // permission mode and every write came back blocked), and that its candidate
    // workspace is its own (4002ba00 put several writers into one shared checkout
    // because `dispatch.worktreeSetup` was declared and `dispatch.worktree` was
    // not). Both are decided HERE — on the one path `spor work` and a one-shot
    // `spor dispatch` share, so the two can never grow contradictory guards
    // (dec-spor-work-loop-generalizes-dispatch) — and both are read by the
    // --print preview below without launching anything.
    //
    // The posture is judged on the EFFECTIVE options (after --read-only and the
    // adapter's own option translation), so what is checked is exactly what
    // buildArgs is about to receive.
    const postureCheck = preflight.checkWritePosture({
      adapter: harnessAdapter,
      options: { permissionMode: permMode, sandbox: effectiveSandbox, approvalPolicy: effectiveApprovalPolicy },
      unattended,
      readOnly,
      harnessId: harness,
      allowAttended,
    });
    // Live writers already in the candidate. Read from the durable run records —
    // the same store the same-machine guard reads — so occupancy can never
    // disagree with what `spor runs` reports. A read-only run (a review gate) is
    // not a writer and never occupies anything.
    const workspaceWriters = backfill
      ? []
      : liveWorkspaceWriters(cfg, dispatchRuns.readRunRecords(cfg.userConfigHome()), workspacePlan.dir);
    const workspaceCheck = preflight.checkWorkspace({ plan: workspacePlan, writers: workspaceWriters, readOnly });
    const previewArgs = harnessAdapter ? harnessAdapter.buildArgs({
      name,
      model: effectiveModel,
      permissionMode: permMode,
      agent,
      sandbox: effectiveSandbox,
      approvalPolicy: effectiveApprovalPolicy,
      reportPath: dispatchHarnesses.REPORT_PLACEHOLDER,
      sporMcp: null,
      readOnly: readOnlyPosture,
    }) : [];
    const supportedHarness = !!harnessAdapter;
    // An UNSATISFIABLE profile is refused further down by the satisfiability path
    // instead, even when the harness is also unsupported here — that refusal
    // names the missing atom AND re-routes to a fleet host that has it, which is
    // strictly more useful for the case the two overlap on: a declared harness
    // nobody bound on THIS box (task-spor-dispatch-declarative-custom-harness).
    // This branch keeps the case satisfiability cannot catch — a harness DECLARED
    // as a capability (`spor capabilities set harnesses …`) that this client
    // still has no adapter or binding for.
    if (!supportedHarness && !dryRun && !unsatisfiable) {
      err(`cannot dispatch ${nodeId || name}: profile ${profileCheck && profileCheck.id ? profileCheck.id : "(unknown)"} selects unsupported harness '${harness}'.`);
      err(`  this client has adapters for ${dispatchHarnesses.harnesses({ cfg }).map((a) => a.id).join(", ")}; the assignment is unchanged.`);
      err(`  a harness with no built-in adapter runs only where its owner bound it — declare`);
      err(`  '${sat.DECLARED_HARNESS_CONFIG_KEY}.${harness}' (command, args, report, session) in $SPOR_HOME/config.json.`);
      return 1;
    }


    // Everything the preview, the guards and the execute phase read, and nothing
    // they could not have read before this split: the plan is the resolved
    // dispatch, not a second copy of the arguments.
    return {
      dryRun, noClaim, autoRoute, autoRouteMaxAge, force, backfill, unattended, model, permMode,
      sandbox, readOnly, approvalPolicy, agent, asAgent, allowPersonToken, templateOpt, nodeId,
      itemRepo, itemCommits, name, template, brief, resolvedReason, readinessCheck, declineFinding,
      res, worktreeSetup, useWorktree, workspacePlan, prompt, inFlight,
      pinnedSession, mcpKey, identityAgent, readinessHuman, readinessRequiresHuman, profileCheck,
      unsatisfiable, profileRuntime, harness, harnessResolution, harnessAdapter, effectiveModel,
      harnessBin, harnessBinCheck, effectiveSandbox, effectiveApprovalPolicy, readOnlyPosture,
      postureCheck, workspaceWriters, workspaceCheck, previewArgs, supportedHarness,
    };
  }

  // `--print`: the diagnostic preview of a plan. Always exit 0.
  function previewDispatch(cfg, plan) {
    const {
      noClaim, autoRoute, force, backfill, permMode, readOnly, asAgent, allowPersonToken,
      templateOpt, nodeId, name, template, brief, resolvedReason, readinessCheck, declineFinding,
      res, worktreeSetup, useWorktree, workspacePlan, prompt, inFlight, pinnedSession,
      identityAgent, readinessHuman, readinessRequiresHuman, profileCheck, unsatisfiable, harness,
      harnessResolution, harnessAdapter, harnessBin, harnessBinCheck, effectiveSandbox,
      effectiveApprovalPolicy, postureCheck, workspaceWriters, workspaceCheck, previewArgs,
      supportedHarness,
    } = plan;
    // The diagnostic preview (task-spor-worker-preflight-validation). It runs
    // the SAME resolution path a real dispatch does — tenant, profile, harness,
    // posture, candidate workspace — and performs none of its side effects: no
    // claim, no child, no worktree, no config write (the plan phase persists
    // nothing, the capability probe included), and no credential is ever
    // echoed, only reported present/missing.
    out(`tenant: ${preflight.tenantLine(preflight.describeTenant(cfg))}`);
    out(`dir:    ${res.dir}  (slug: ${res.slug}, via ${res.source})`);
    if (useWorktree) {
      out(
        `worktree: ${dispatchWorktreeDir(res.dir, name)}  (branch ${worktreeName(name)}, off HEAD)` +
          (worktreeSetup ? `; setup: ${worktreeSetup}` : `; no setup hook (dispatch.worktreeSetup unset)`)
      );
    }
    out(
      `workspace: ${workspacePlan.dir}  (${workspacePlan.isolation === "worktree" ? "isolated worktree" : "SHARED checkout — every dispatch here writes to one tree"})` +
        (workspaceWriters.length ? `; ${workspaceWriters.length} live writer(s): ${preflight.describeWriters(workspaceWriters)}` : "; no live writers here")
    );
    if (workspacePlan.setupOrphaned) {
      out(
        `  note: dispatch.worktreeSetup is declared but dispatch.worktree is not — a setup hook does NOT enable isolation,`
      );
      out(`        so the hook never runs and the agent writes into ${res.dir} itself. Set dispatch.worktree true (or pass --worktree).`);
    }
    out(`posture: ${preflight.postureLine(postureCheck)}`);
    if (backfill) {
      const steps = [];
      if (cfg.mode() !== "remote") steps.push(fs.existsSync(cfg.nodesDir()) ? "graph home ready" : "init graph home");
      steps.push(`register ${res.slug} → ${res.dir}`);
      if (!cfg.enabled()) steps.push("re-enable repo (currently disabled)");
      out(`onboard: ${steps.join("; ")}`);
    }
    out(`brief:  ${brief ? `${brief.length} bytes` : "(none — graph had nothing relevant, or --no-brief/--backfill)"}`);
    if (profileCheck) out(`harness: ${harness} (profile ${profileCheck.id})`);
    out(`session: ${pinnedSession || (harnessAdapter ? harnessAdapter.sessionPreview : "(unsupported harness)")}`);
    // Identity preview: what the real dispatch would do for agent-scoping. The
    // token mint + 0600 mcp-config are SIDE EFFECTS, so --print only describes
    // them (it writes nothing and makes no network call here). Local mode and an
    // unconfigured machine read "person-scoped" — byte-stable but for the new
    // session line, which is additive and always present now.
    if (identityAgent) {
      const src = asAgent ? " (via --as)" : "";
      // The note is DECLARED by the adapter rather than branched on here, so a
      // new harness describes its own identity mechanism instead of falling
      // through to whichever branch it least resembles.
      const claudeNote = dispatchHarnesses.getHarness("claude-code").identityNote;
      out(`agent:  ${identityAgent}${src} ${(harnessAdapter && harnessAdapter.identityNote) || claudeNote}`);
    } else if (cfg.mode() === "remote") {
      out(
        `agent:  (none configured — 'spor agent use agent-<machine>' or --as to attribute as agent-on-behalf-of)` +
          (allowPersonToken
            ? " — dispatching person-scoped (--allow-person-token)"
            : " — real dispatch would REFUSE (pass --allow-person-token to dispatch person-scoped anyway)")
      );
    }
    // Already-resolved guard preview (node mode, any mode): a real dispatch would
    // refuse a target that is already done. Shown first — and only on a hit, so a
    // clean node --print stays byte-identical to before — mirroring the real-run
    // precedence below (the resolved guard is checked before the profile/in-flight ones).
    if (resolvedReason) {
      out(
        `resolved: ${nodeId} is already resolved (${resolvedReason})` +
          (force ? " — --force set, dispatching anyway" : " — real dispatch would refuse (--force overrides)")
      );
    }
    // Decline-finding guard preview (node mode, any mode): shown only on a hit,
    // so a clean --print stays byte-identical (task-spor-decline-finding-gates-
    // redispatch).
    if (declineFinding) {
      out(
        `declined: ${nodeId} carries a live decline finding (${declineFinding.id})` +
          (force ? " — --force set, dispatching anyway" : " — real dispatch would refuse (--force overrides)")
      );
    }
    // Agent-readiness guard preview (shown only when the node's derived
    // readiness is decisively human, so a clean/agent-ready/untriaged --print
    // stays byte-identical). requires:human is the one reason with NO --force
    // override — the risk-class register, not a capability gap.
    if (readinessHuman) {
      out(
        `readiness: human — ${readinessCheck.reasons.join(", ")}` +
          (readinessRequiresHuman
            ? " — real dispatch would REFUSE (no --force override)"
            : " — real dispatch would warn and proceed")
      );
    }
    // Profile satisfiability preview (shown only when a profile resolves, so a
    // profile-free --print stays byte-identical). A real dispatch refuses when
    // UNSATISFIABLE, leaving the assignment intact.
    if (profileCheck && profileCheck.verdict) {
      const v = profileCheck.verdict;
      out(`profile: ${profileCheck.id} (via ${profileCheck.source}) — ${v.ok ? "satisfiable here" : "UNSATISFIABLE here; real dispatch would refuse"}`);
      for (const r of v.reasons) out(`  - ${r}`);
    }
    // Auto-route preview (shown only when the autonomous tier is armed AND the
    // profile is unsatisfiable here, so every other --print stays byte-identical).
    // The dry run itself consults nothing and writes nothing — it says what a
    // real dispatch WOULD do, like the guards above it.
    if (autoRoute && unsatisfiable && cfg.mode() === "remote") {
      out(
        nodeId && !backfill
          ? `auto-route: ON — real dispatch would hand ${nodeId} to the freshest fleet host that satisfies ${profileCheck.id} (assigned → <host agent>, same profile), or escalate if none does`
          : `auto-route: ON — but only a NODE dispatch can be re-routed; this run has nothing to re-assign, so it would refuse and report the hosts`
      );
    }
    // Same-machine guard preview (node mode, any mode): a real dispatch would
    // refuse if an agent with this name is already in flight here. Shown only on a
    // hit, so a clean node --print stays byte-identical to before.
    if (inFlight.length) {
      out(
        `in-flight: ${name} already has ${inFlight.length} agent(s) in flight here` +
          (force ? " — --force set, dispatching anyway" : " — real dispatch would refuse (--force overrides)")
      );
    }
    // Auto-claim preview (remote node dispatch only — local mode has no lease, so
    // nothing is announced there and local --print stays byte-identical).
    if (nodeId && !backfill && cfg.mode() === "remote") {
      out(`claim:  ${noClaim ? "(--no-claim — lease not established)" : `would establish a lease on ${nodeId} at launch (session bound from the run after launch)`}`);
    }
    // The preflight verdict itself, stated once so a preview never reads as a
    // clean run the real dispatch would refuse. Judged for an UNATTENDED
    // launch, since that is the caller with nobody to answer a prompt; an
    // interactive dispatch is told so rather than being silently exempted.
    const previewPosture = preflight.checkWritePosture({
      adapter: harnessAdapter,
      options: { permissionMode: permMode, sandbox: effectiveSandbox, approvalPolicy: effectiveApprovalPolicy },
      unattended: true,
      readOnly,
      harnessId: harness,
    });
    const blocks = [];
    if (!previewPosture.ok) blocks.push(`posture — ${previewPosture.reason}`);
    if (!workspaceCheck.ok) blocks.push(`workspace — ${workspaceCheck.reason}`);
    if (blocks.length) {
      out(`preflight: a worker dispatch here would REFUSE:`);
      for (const b of blocks) out(`  - ${b}`);
      if (!previewPosture.ok && previewPosture.hint) out(`    ${previewPosture.hint}`);
      if (!workspaceCheck.ok && workspaceCheck.hint) out(`    ${workspaceCheck.hint}`);
    } else if (previewPosture.warning) {
      out(`preflight: ${previewPosture.warning.replace(/^warning: /, "")}`);
    } else out(`preflight: ok — write posture and candidate workspace are both fit for an unattended run`);
    if (template != null) out(`template: ${path.resolve(templateOpt)}`);
    if (harnessResolution.error) out(`run:    (declaration for harness '${harness}' is unusable: ${harnessResolution.error})`);
    else if (!harnessBinCheck.ok) out(`run:    (${harnessBinCheck.error})`);
    else if (!supportedHarness) out(`run:    (unsupported harness '${harness}')`);
    else if (harnessAdapter.launchMode === "supervised-jsonl") {
      out(`run:    ${harnessBin} ${previewArgs.map((a) => renderLaunchArg(a, { embedded: !!harnessAdapter.declaration })).join(" ")}  # prompt on stdin`);
    } else out(`run:    ${harnessBin} ${previewArgs.map(shellQuote).join(" ")} <prompt>`);
    out(`\n--- prompt ---\n${prompt}`);
    return 0;
  }

  // The real-run guards, judged on the plan. Returns an exit code on refusal,
  // null to proceed.
  async function refuseDispatch(cfg, plan) {
    const {
      autoRoute, autoRouteMaxAge, force, backfill, nodeId, name, readinessCheck, inFlight,
      identityAgent, readinessHuman, profileCheck, unsatisfiable, postureCheck,
    } = plan;
    // The already-RESOLVED guard, the decline-finding guard, and the
    // requires:human agent-readiness guard all already refused above (before
    // profile resolution) on a real run — nothing left to check here for those.
    // The broader `readiness: human`
    // classification (assigned to a person, a held task, an open neighborhood
    // question, or the item itself a question/capture) is not a capability gap and
    // was never a refusal — it only WARNS and the dispatch proceeds, so that check
    // stays here, after profile resolution, alongside the guards below it.
    if (readinessHuman) {
      err(`warning: ${nodeId || name}'s derived readiness is human, not agent — ${readinessCheck.reasons.join(", ")}.`);
      err(`  dispatching anyway; 'spor next' shows the same signal if you'd rather triage first.`);
    }

    // Refuse BEFORE any side effect if this machine can't satisfy the resolved
    // profile (dec-spor-machine-profile-satisfiability, FORK B): fail soft and
    // loud, leave the task assigned and its lease/queue state untouched, NEVER
    // substitute a different profile. The human/routine chose THIS profile; a box
    // that can't honour it re-routes, it doesn't silently downgrade. No --force
    // bypass — that would be the silent substitution this rule forbids.
    if (unsatisfiable) {
      err(`cannot dispatch ${nodeId || name} here: this machine can't satisfy profile ${profileCheck.id} (via ${profileCheck.source}).`);
      for (const r of profileCheck.verdict.reasons) err(`  - ${r}`);
      // Substitution-free re-routing CONSUMER (task-spor-fleet-scheduler-autoroute-
      // dispatch): instead of a dead-end "re-route somewhere" hint, consult the
      // fleet scheduler (GET /v1/profiles/{id}/hosts, art-spor-remote-fleet-
      // scheduler-shipped) and NAME the boxes that can satisfy THIS exact profile,
      // or — when none can — say so and escalate to the owner (FORK B: never
      // substitute a different profile). Remote-only and FAIL-SOFT: an
      // unreachable/undeployed scheduler falls through to the generic hint, so the
      // refusal still works offline and local mode stays byte-identical.
      //
      // With --auto-route (dispatch.autoRoute) the AUTONOMOUS tier runs first
      // (task-spor-fleet-autoroute-auto-tier-consumer): it takes the same
      // host-match and, for a NODE dispatch, hands the item to the freshest
      // satisfying box by writing `assigned → <agent> {profile: <this profile>}`,
      // so no human re-routes it. Anything it can't act on — a free-text dispatch
      // with no node to assign, no satisfying host, a scheduler outage, a refused
      // edge write — degrades to the human-tier report ABOVE. A `--print` dry run
      // never reaches here at all (it returned with its preview above), so no dry
      // run can write the edge.
      //
      // That fallback reuses the auto tier's fetch only where the two tiers are
      // asking the same question. They usually are not: the auto tier asks a
      // NARROWED one (`owner=me`, bounded by autoRouteMaxAge) because it is
      // choosing a machine to hand work to, while the report answers a human's
      // "where could this run at all". Rendering the narrow answer as the broad one
      // turns a laptop that has been quiet overnight — or, for an admin, a
      // colleague's box — into "NO fleet host currently satisfies X, escalate to
      // the owner", which is both false and the opposite of the useful advice; and
      // a typo'd autoRouteMaxAge (a 422) would be reported as a scheduler outage.
      // So the reuse is limited to the one shape that cannot mislead — a target was
      // chosen and only the edge write failed (`reusable`) — and every other
      // non-routing outcome re-asks broadly, printing exactly what an
      // auto-route-free refusal would, at the cost of one bounded GET.
      let routed = false;
      if (cfg.mode() === "remote") {
        const canRoute = autoRoute && !!nodeId && !backfill;
        const auto = canRoute
          ? await autoRouteToFleetHost(cfg, {
              nodeId,
              profileId: profileCheck.id,
              ownAgents: [identityAgent, dispatchAgentId(cfg)],
              maxAge: autoRouteMaxAge,
            })
          : null;
        routed = auto && auto.routed ? true : await reportFleetHosts(cfg, profileCheck.id, auto && auto.reusable ? { prefetched: auto.res } : {});
      }
      if (!routed) {
        err(`  the assignment is unchanged. Re-route to a machine that satisfies it, run 'spor capabilities' to`);
        err(`  declare/repair what's missing here, or pass a different --profile.`);
      }
      return 1;
    }

    // Refuse an unattended launch that cannot WRITE, BEFORE any side effect
    // (task-spor-worker-preflight-validation). The Dartlane pilot's `fe24cc97`
    // ran a whole claimed item under a posture that stops to ask, with nobody to
    // answer: every write came back permission-blocked and the item was reported
    // against work that never happened. There is deliberately no --force
    // override and preflight never SETS a posture — a worker that quietly grants
    // itself a permission bypass is the substitution this refusal exists to
    // prevent; the fix is the profile's, or the operator's, to make explicitly.
    // An interactive dispatch is never judged here (a person IS the answer).
    if (postureCheck.warning) err(postureCheck.warning);
    if (!postureCheck.ok) {
      err(`cannot dispatch ${nodeId || name}: ${postureCheck.reason}.`);
      err(`  ${postureCheck.hint}`);
      err(`  nothing was claimed or launched; the assignment is unchanged.`);
      return 1;
    }
    // Refuse a same-machine duplicate BEFORE any side effect or claim
    // (task-spor-dispatch-same-machine-guard): no repo registration, no lease, no
    // launch for a node already in flight here. --force overrides.
    if (inFlight.length && !force) {
      err(`${name} already has a background agent in flight on this machine — not dispatching a duplicate.`);
      err(`  in flight: ${inFlight.map((a) => `${a.id || "?"}${a.state ? ` (${a.state})` : ""}`).join(", ")}`);
      err(`  re-run with --force to dispatch anyway, or 'spor next --json' to review what's already running.`);
      return 1;
    }

    return null;
  }

  // The side effects. Every refusal from here on has something to undo, and
  // undoes it (the claim, the workspace lock, a half-prepped worktree).
  async function executeDispatch(cfg, plan, ctx = null) {
    const {
      noClaim, force, backfill, permMode, readOnly, agent, allowPersonToken, nodeId, itemRepo,
      itemCommits, name, res, useWorktree, workspacePlan, prompt, mcpKey, identityAgent,
      profileCheck, profileRuntime, harnessAdapter, effectiveModel, harnessBin, effectiveSandbox,
      effectiveApprovalPolicy, readOnlyPosture, workspaceCheck,
    } = plan;
    // Close the race the guard above cannot (issue-spor-local-mode-work-loop-
    // concurrency-hazard): remote mode's server-held claim below makes THAT
    // guard atomic; local mode has none, so this machine-local lock is what
    // stands between two `spor work` loops (or dispatches) picking the same
    // node in the same tick. --force means "dispatch anyway" for the in-flight
    // guard above, so it means the same here — a forced dispatch takes no lock
    // and contends with nothing. Released in the `finally` below, whichever way
    // the rest of this dispatch ends.
    let localDispatchLock = null;
    if (nodeId && !backfill && cfg.mode() !== "remote" && !force) {
      const acquired = acquireLocalDispatchLock(cfg.userConfigHome(), name);
      if (!acquired.ok) {
        err(`${name} is already being dispatched by another 'spor work'/'spor dispatch' on this machine right now — not launching a duplicate.`);
        err(`  this is the local-mode race window dispatchedAgents() cannot see yet; re-run in a moment, or 'spor next --json' to check what's in flight.`);
        return 1;
      }
      localDispatchLock = acquired.file ? acquired : null;
    }

    try {
      // Refuse two writers in one candidate workspace, likewise before any side
      // effect. Isolation is per-dispatch and opt-in, so with it off every dispatch
      // into a repo shares one working tree and one index — the pilot's `4002ba00`,
      // where three agents committed over each other in /home/exedev/dartlane.
      // --force overrides, as it does for the other same-machine guards; the work
      // loop never passes it, which is what keeps a pull worker out of this.
      if (!workspaceCheck.ok && !force) {
        err(`cannot dispatch ${nodeId || name}: ${workspaceCheck.reason}.`);
        err(`  ${workspaceCheck.hint}`);
        err(`  re-run with --force to write into it anyway; nothing was claimed or launched.`);
        return 1;
      }
      if (!workspaceCheck.ok) err(`warning: --force set — dispatching a second writer into ${workspacePlan.dir}.`);
      // A declared worktree SETUP hook with isolation off is not an error (the hook
      // never enables isolation by itself, and must not start doing so) but it is
      // almost always a mistake: the hook never runs and the agent writes into the
      // main checkout. Say so once, loudly, where the operator will see it.
      if (workspacePlan.setupOrphaned) {
        err(`warning: ${res.slug} declares dispatch.worktreeSetup but not dispatch.worktree — a setup hook does not enable isolation,`);
        err(`  so the hook is skipped and this run writes into ${res.dir} itself. Set dispatch.worktree true in its .spor.json (or pass --worktree).`);
      }

      // Preflight only the PATH route — a launcher naming no directory, whether it
      // is the adapter default or an explicitly configured bare name. A launcher
      // given as a PATH is left to the launch, whose own `could not launch <path>:
      // ENOENT` already names the exact path that was tried, and which releases the
      // claim this dispatch established; refusing it earlier would skip that.
      const binary = dispatchHarnesses.describeHarnessBin(harnessAdapter, { env: process.env, cfg });
      if (binary.onPath && !hasCmd(binary.command)) {
        err(binary.explicit
          ? `${binary.command} not found on PATH (${binary.source} names it) — install it, or give ${binary.source} an absolute path.`
          : `${harnessAdapter.missingBinary}, then re-run (or 'spor dispatch … --print' to see the prompt).`);
        return 1;
      }

      // Agent-scoped identity injection (dec-spor-session-identity-active-record,
      // the VERIFIED mechanism): mint a per-session agent-scoped token, write it into
      // a 0600 --mcp-config that exposes ONLY the agent's own Spor MCP, and add
      // --strict-mcp-config so the account connector is excluded by construction. The
      // server then stamps authored_by_agent + session from that token. The token is
      // minted session-DEFERRED — the run session isn't known until the harness's
      // supervised stream reports it, so we bind it AFTER launch
      // (dec-spor-dispatch-bg-session-late-bind, from inside launchSupervisedHarness
      // via `bindToken`/`renewToken`), keeping `agentToken` to authenticate that
      // bind. Per
      // dec-spor-worker-strictness-split-interactive-lenient a mint failure now HARD
      // FAILS — a server without the mint surface, or a transient minting error, must
      // not silently attribute the dispatched agent's writes to the person — unless
      // --allow-person-token (or dispatch.allowPersonToken) opts back into the old
      // fail-soft. Nothing has claimed a lease, written local config, or launched
      // anything yet, so a hard fail here leaves no cleanup behind
      // (issue-spor-dispatch-config-write-before-mint-fail: this block must stay
      // ahead of the "Side effects" registration below, not just the claim/launch —
      // a mint failure that hard-fails must not have already mutated
      // dispatch.repos). Remote + a configured agent only; local/unconfigured
      // dispatch never reaches this block.
      let agentToken = null;
      let agentMcpFile = null;
      if (identityAgent) {
        // Always session-DEFERRED — the run session is bound after launch (below),
        // even when SPOR_SESSION_ID pins it (the pin only labels the preview),
        // so the bind path is uniform.
        const mint = await mintAgentToken(cfg, { agent: identityAgent });
        if (mint.ok) {
          agentToken = mint.token;
          if (harnessAdapter.identityMode === "mcp-file") {
            agentMcpFile = writeDispatchMcpConfig(cfg, { token: mint.token, key: mcpKey });
          }
          out(`agent:  ${identityAgent} (writes attributed agent-on-behalf-of-you; run session bound after launch)`);
        } else if (!allowPersonToken) {
          // Name the offending agent and the fix — a bare "(HTTP 422 …)" tells the
          // operator nothing about WHICH id is wrong or how to repair it. The format
          // gate is caught client-side above, so a 422 here means the id is a
          // well-formed 'agent-<slug>' the server still rejected (e.g. no such agent /
          // not owned); point at the list either way
          // (issue-spor-dispatch-agent-id-prefix-validation-gap).
          err(
            `cannot dispatch ${nodeId || name}: could not mint an agent-scoped token for ${identityAgent}` +
              `${mint.absent ? " (this server can't mint agent-scoped session tokens yet)" : ` (${mint.error})`}.`
          );
          err(`  check it exists and you own it: spor agent list  (fix: spor agent use <agent-id>)`);
          err(`  pass --allow-person-token to dispatch person-scoped anyway (dispatch.allowPersonToken makes it standing).`);
          return 1;
        } else if (mint.absent) {
          err(`warning: this server can't mint agent-scoped session tokens yet — dispatching person-scoped (--allow-person-token).`);
        } else {
          err(`warning: could not mint an agent token for ${identityAgent} (${mint.error}) — dispatching person-scoped (--allow-person-token).`);
          err(`  check it exists and you own it: spor agent list  (set this machine's default with: spor agent use <agent-id>)`);
        }
      }

      // Local config side effects (real run only — --print writes nothing), now
      // that a hard mint failure above has already returned without reaching here.
      // --backfill is the onboarding door, so it sets the repo up (init + enable)
      // first; every dispatch self-registers the dir it resolved.
      if (backfill) onboardRepo(cfg, res.dir);
      // The slug->path map is machine-local — written to the PERSONAL user config
      // home, never the (possibly marker-shared) graph home
      // (issue-spor-config-desync-shared-graph-home).
      // An explicit --dir is a per-dispatch override and never writes the map: for a
      // node stamped with another repo it would remap THAT repo's slug to this dir
      // (issue-spor-dispatch-dir-rewrites-repo-map-for-cross-repo-node). --backfill
      // is the onboarding door and still registers what it set up.
      if (res.source !== "--dir" || backfill) u.registerRepo(cfg.userConfigHome(), res.slug, res.dir);
      // The capability probe profile resolution took for the satisfiability
      // verdict, refreshed into config.json only now that the dispatch is
      // really going ahead (a refusal above leaves it untouched).
      if (profileCheck && profileCheck.probed) u.persistProbedCapabilities(cfg.userConfigHome(), profileCheck.probed);
      if (backfill) out(`registered ${res.slug} → ${res.dir}; launching the backfill agent…`);

      // Establish the claim/lease BEFORE launching (task-spor-dispatch-auto-claim):
      // a node already claimed by someone else is caught here, so we never launch a
      // duplicate agent onto contested work, and the lease is live the moment the
      // agent starts (its post-tool writes then renew it — and seeing its own held
      // claim, it skips the redundant claim-nudge). Remote node-mode only; --no-claim
      // opts out (dispatch with no lease, the prior behavior). PERSON-SCOPED here
      // (session omitted, dec-spor-dispatch-bg-session-late-bind): the real session
      // isn't known until the harness's supervised stream announces it after launch,
      // so we bind it to the lease from inside launchSupervisedHarness (renewNode/
      // renewToken, below) once it does; until then any of this person's sessions
      // may renew it.
      let claimEstablished = false;
      if (nodeId && !backfill && !noClaim && cfg.mode() === "remote") {
        // Tag this claim with a per-invocation dispatch nonce so the server refuses a
        // SECOND concurrent dispatch of the same node — even by this same person, on
        // any machine (inc-spor-dispatch-duplicate-task-2026-06-18). --force opts out
        // (omit the nonce) so a deliberate re-dispatch renews instead of conflicting.
        const dispatchNonce = force ? null : crypto.randomUUID();
        const c = await claimDispatch(cfg, nodeId, null, dispatchNonce);
        if (c.conflict) {
          err(`${nodeId} is already claimed — ${c.message}`);
          err(`  not dispatching a duplicate. Re-run with --force to dispatch anyway (keeps the lease),`);
          err(`  --no-claim to dispatch with no lease, or pick another task with 'spor next'.`);
          return 1;
        }
        if (c.ok) {
          // Only mark this as a lease WE established: a --force claim omits the
          // nonce and RENEWS whatever lease already exists (per the conflict
          // message above, "keeps the lease") — that may be a live lease held by
          // an already-running agent from an earlier dispatch. Abort-cleanup below
          // must never release a lease this invocation didn't freshly create.
          claimEstablished = !!dispatchNonce;
          out(`claimed ${nodeId} (lease established; the agent's writes will renew it)`);
        } else err(`warning: could not establish a lease on ${nodeId}: ${c.error} — dispatching without a claim`);
      }
      // A worktree-creation/setup-hook failure, or a failure to even launch the
      // agent process, below aborts the dispatch without ever running an agent —
      // release the lease claimed just above so it doesn't strand the node
      // claimed-but-unattended (issue-spor-dispatch-worktree-setup-wrong-repo-
      // config: the failed attempt used to need a manual `spor release` before a
      // retry). Best-effort: a release failure here just leaves the existing
      // "needs a manual spor release" state, no worse than before.
      const releaseClaimOnAbort = async () => {
        if (!claimEstablished) return;
        const r = await remote.post(cfg, `/v1/nodes/${encodeURIComponent(nodeId)}/release`, {}, { timeoutMs: 6000 });
        if (r.ok) out(`  released the claim on ${nodeId}`);
        else err(`  warning: could not release the claim on ${nodeId} — retry with 'spor release ${nodeId}'`);
      };
      // Take the candidate workspace ATOMICALLY, then re-check it
      // (task-spor-worker-preflight-validation). The occupancy check above reads
      // the run records; the record that would make a SECOND dispatch see THIS one
      // is written by the launch below. Two launchers racing through that window
      // both read an empty candidate and both land in it — the check/launch race
      // acceptance names. So the claim on the candidate path is held from here
      // until the run record exists, and the occupancy question is asked again
      // under it. Machine-local and self-healing (a lock whose holder is gone, or
      // older than a launch could take, is ignored and cleared); an unwritable
      // journal degrades to "no lock", never to a refusal to dispatch.
      //
      // This is the one refusal that comes AFTER the claim, because it exists only
      // to break a tie the pre-claim check could not see — so it hands the lease
      // straight back, exactly as a failed worktree setup does.
      // A read-only launch claims nothing: it is not a writer, so it neither
      // occupies the candidate nor needs to exclude anyone from it.
      let workspaceLock = null;
      if (!backfill && !readOnly) {
        const held = await preflight.acquireWorkspace(cfg.userConfigHome(), workspacePlan.dir, {
          // How long to wait for a contender that is mid-launch before giving up on
          // the tiebreak. A launch takes seconds; the default leaves room for a
          // slow one without making a stuck box wait minutes.
          waitMs: cfg.getNum("dispatch.workspaceLockWaitMs", preflight.WORKSPACE_LOCK_WAIT_MS),
        });
        // Fail-open is right — an unwritable journal must not be what stops a
        // dispatch — but it must not be SILENT: the launch is running with no race
        // tiebreak, and on a box where the journal is unwritable that is EVERY
        // launch, whose first symptom would otherwise be two agents in one checkout.
        if (held.degraded) {
          err(`warning: could not claim the candidate workspace (${held.degraded}) — dispatching without the concurrent-launch tiebreak.`);
        }
        // `--force` is the operator (or a gate fix cycle / rescue, the two worker
        // launches that pass it) saying "write into it anyway". Refusing THEM at the
        // acquisition arm would contradict the guard it is only the tiebreak for —
        // and a fix dispatch refused here spends a cycle from a bounded budget — so
        // a forced launch degrades to "no tiebreak" rather than to a refusal, the
        // same arm an unwritable journal takes.
        if (!held.ok && !force) {
          err(`cannot dispatch ${nodeId || name}: another dispatch on this box is launching into ${workspacePlan.dir} right now.`);
          err(`  re-try in a moment${workspacePlan.isolation === "shared" ? ", or enable dispatch.worktree for this repo so the two runs get their own trees" : ""}.`);
          await releaseClaimOnAbort();
          return 1;
        }
        workspaceLock = held.ok ? held.token : null;
        const racers = liveWorkspaceWriters(cfg, dispatchRuns.readRunRecords(cfg.userConfigHome()), workspacePlan.dir);
        const recheck = preflight.checkWorkspace({ plan: workspacePlan, writers: racers, readOnly });
        if (!recheck.ok && !force) {
          err(`cannot dispatch ${nodeId || name}: ${recheck.reason} (it started while this dispatch was preparing).`);
          err(`  ${recheck.hint}`);
          preflight.releaseWorkspace(workspaceLock);
          await releaseClaimOnAbort();
          return 1;
        }
      }
      const abortLaunch = async () => {
        preflight.releaseWorkspace(workspaceLock);
        await releaseClaimOnAbort();
      };

      // Materialize the worktree just before launch — AFTER every guard/claim, so a
      // refused dispatch never leaves a worktree behind — and run the agent inside it.
      // res.dir stays the registered slug->path target (the durable main checkout,
      // issue-spor-dispatch-worktree-dir-stamping); only the launch cwd moves.
      let launchDir = res.dir;
      if (useWorktree) {
        const wt = createDispatchWorktree(res.dir, name, { slug: res.slug, nodeId });
        if (wt.error) {
          err(`could not create dispatch worktree under ${res.dir}: ${wt.error}`);
          err(`  (is ${res.dir} a git repo with at least one commit? or pass --no-worktree.)`);
          await abortLaunch();
          return 1;
        }
        if (wt.setupError) {
          err(`dispatch worktree setup hook failed: ${wt.setupError}`);
          if (wt.created) {
            const rm = removeDispatchWorktree(res.dir, wt.dir, wt.branch);
            if (rm.removed) {
              err(`  removed the half-prepped worktree ${wt.dir}. Fix dispatch.worktreeSetup or pass --no-worktree.`);
            } else {
              err(`  could not remove the half-prepped worktree ${wt.dir}: ${rm.reason}`);
              err(`  clean it up manually, then fix dispatch.worktreeSetup or pass --no-worktree.`);
            }
          } else {
            err(`  left the reused worktree ${wt.dir} in place. Fix dispatch.worktreeSetup or pass --no-worktree.`);
          }
          await abortLaunch();
          return 1;
        }
        launchDir = wt.dir;
        out(`worktree: ${wt.dir} (branch ${wt.branch}${wt.reused ? ", reused" : ""}${wt.setupRan ? "; setup ran" : ""})`);
      }

      if (harnessAdapter.launchMode === "supervised-jsonl") {
        const personToken = cfg.mode() === "remote" ? remote.token(cfg) : "";
        const mcpToken = agentToken || personToken;
        const wantsSporMcp = harnessAdapter.identityMode === "env-mcp" && cfg.mode() === "remote" && (
          !!identityAgent || (Array.isArray(profileRuntime.mcp) && profileRuntime.mcp.includes("spor"))
        );
        const args = harnessAdapter.buildArgs({
          name,
          model: effectiveModel,
          permissionMode: permMode,
          agent,
          // The `mcp-file` identity mechanism (Claude Code): the agent-scoped token
          // rides the 0600 --mcp-config written above, exactly as the native launch
          // carried it; an `env-mcp`/`env-token` adapter never has a file here.
          mcpConfig: agentMcpFile,
          sandbox: effectiveSandbox,
          approvalPolicy: effectiveApprovalPolicy,
          reportPath: dispatchHarnesses.REPORT_PLACEHOLDER,
          sporMcp: wantsSporMcp && mcpToken ? { url: `${remote.base(cfg)}/mcp` } : null,
          readOnly: readOnlyPosture,
        });
        const launched = await launchSupervisedHarness(cfg, {
          adapter: harnessAdapter,
          command: harnessBin,
          args,
          cwd: launchDir,
          readOnly: !!readOnlyPosture,
          name,
          nodeId,
          prompt,
          server: cfg.mode() === "remote" ? remote.base(cfg) : null,
          localNodesDir: cfg.mode() === "remote" ? null : cfg.nodesDir(),
          childToken: agentToken,
          mcpToken: wantsSporMcp ? mcpToken : null,
          bindToken: agentToken,
          renewToken: agentToken || personToken,
          renewNode: nodeId && !backfill && !noClaim ? nodeId : null,
          releaseNode: claimEstablished ? nodeId : null,
          project: res.slug || null,
          itemRepo,
          itemCommits,
          resolvedProfile: profileCheck && profileCheck.id ? profileCheck.id : null,
          recordFields: ctx && ctx.recordFields ? ctx.recordFields : null,
        });
        if (!launched.ok) {
          err(`could not launch ${harnessBin}: ${launched.error}`);
          await abortLaunch();
          return 1;
        }
        if (ctx && ctx.onLaunch) {
          ctx.onLaunch({
            run_id: launched.runId, harness: harnessAdapter.id, launch_mode: harnessAdapter.launchMode,
            node_id: nodeId || null, record_path: launched.paths.record,
          });
        }
        // The run record exists now, so a concurrent dispatch's occupancy check can
        // see this run: the candidate claim has done its job and is handed back.
        preflight.releaseWorkspace(workspaceLock);
        out(`run:     ${launched.runId} (${harnessAdapter.label} supervisor ${launched.state.state || "launching"})`);
        out(`log:     ${launched.paths.log}`);
        out(`report:  ${launched.paths.report}`);
        if (launched.state.session_id) out(`session: ${launched.state.session_id}`);
        return 0;
      }

      // Every adapter launches supervised (the native `claude --bg` launch is
      // retired, task-spor-deprecate-native-bg-dispatch); an adapter declaring any
      // other mode is a registry bug, refused rather than guessed at.
      err(`cannot dispatch ${nodeId || name}: harness '${harnessAdapter.id}' declares launch mode '${harnessAdapter.launchMode}', which spor no longer launches (only supervised-jsonl).`);
      await abortLaunch();
      return 1;
    } finally {
      releaseLocalDispatchLock(localDispatchLock);
    }
  }

  async function cmdDispatch(cfg, args, ctx = null) {
    const plan = await planDispatch(cfg, args, ctx);
    if (typeof plan === "number") return plan;
    if (plan.dryRun) return previewDispatch(cfg, plan);
    const refused = await refuseDispatch(cfg, plan);
    if (refused != null) return refused;
    return executeDispatch(cfg, plan, ctx);
  }

  return { planDispatch, previewDispatch, refuseDispatch, executeDispatch, cmdDispatch };
}

module.exports = { HOST_FUNCTIONS, createDispatcher };
