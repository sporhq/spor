"use strict";
// `spor work` — plan, preview, execute
// (task-spor-extract-work-loop-plan-execute-and-outcome-door).
//
// The pull-based continuous worker (task-spor-work-loop) used to be one
// 800-line function in bin/spor.js that parsed its options, loaded the
// factory, probed capabilities (persisting the probe) and started the loop in
// one pass, so "refuse before any side effect" was a comment someone had to
// keep true. It is now the same shape as lib/shell/dispatch.js:
//
//   planWork     parse and validate every option, load and validate the
//                factory and its gh/publication satisfiability, resolve the
//                repo scope. READS ONLY: it may print and read the graph and
//                config, and it never writes a file, the graph or a lock (the
//                capability probe is not persisted, the bundle store is
//                checked without being created).
//   previewWork  `--print` / `--dry-run`: the worker's diagnostic preview over
//                the same candidate page the loop reads. No writes.
//   executeWork  `--regate` / `--regate-flakes`, or the loop itself
//                (lib/shell/work-loop.js runWorkLoop) and its per-pass deps.
//
// The loop machine stays in work-loop.js; this module is its wiring. Every CLI
// helper the phases need (the queue page, the dispatcher, the gate pipeline,
// the reconcilers, stdout/stderr — err is the ERR_TEE-aware writer the loop
// reads refusal reasons through) is INJECTED as `host`, so the module requires
// only lib code and a test can drive a plan against a fake host.

const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const remote = require(path.join(ROOT, "lib", "remote.js"));
const { loadConfig } = require(path.join(ROOT, "lib", "config.js"));
const gatesKernel = require(path.join(ROOT, "lib", "kernel", "gates.js"));
const stageProjection = require(path.join(ROOT, "lib", "shell", "stage-projection.js"));
const preflight = require(path.join(__dirname, "preflight.js"));
const workLoop = require(path.join(__dirname, "work-loop.js"));
const candidatePublish = require(path.join(__dirname, "candidate-publish.js"));
const dispatchHarnesses = require(path.join(__dirname, "dispatch-harnesses.js"));
const dispatchRuns = require(path.join(__dirname, "agent-dispatch-runner.js"));
const processIdentity = require(path.join(__dirname, "process-identity.js"));

// The CLI helpers the worker needs, named so a missing one fails at
// construction rather than as a ReferenceError halfway through a pass.
const HOST_FUNCTIONS = Object.freeze([
  "err", "out", "annotateInFlight", "checkProposals", "cmdWorkRegate", "cmdWorkRegateFlakes",
  "cmdWorkStatus", "codeWatchRef", "dispatchAgentId", "dispatchSatisfiableWorkItem",
  "dispatchWorktreeDir", "dispatchableQueuePage", "dispatchedAgents", "escalateParkedPipeline",
  "factoryScopeSlug", "gateCoveragePreview", "integrationSatisfiability", "isAgentId",
  "loadFactoryDefinition", "loadedCodeCommit", "makeCodeMovedNotice", "makeFactoryAvailabilityCheck",
  "pollWorkRuns", "reconcileCompletions", "reconcileWithdrawnExecutions", "renewLiveExecutions",
  "replayAttestationDebts", "resolveDir", "retryOneEscalation", "runGateAndIntegration",
  "takeProjectWarning", "targetRepoDispatchCfg", "warnQueueProjectOnce", "workerAlive",
]);

// The work loop's settled-verdict stamp (markGate,
// issue-spor-gate-stamps-bypass-lease-owner): ONE compare-and-swap under the
// record lock. With the lease token this worker's own claim minted, through
// stampGateState's `own` door — it lands only while that token still holds
// the pipeline, so a driver whose lease another worker took over stamps
// nothing. With no token (the pass threw before it claimed, or there was no
// record to own), only on a record nobody has EVER claimed (everClaimed: no
// lease, and no legacy `gate_settle_id`/`gate_at` claim either). Either way a
// record already carrying a settled verdict is left as it reads.
function stampLoopVerdict(home, runId, patch, own) {
  const unsettled = (fresh) => (fresh.gate_state && gatesKernel.SETTLED_GATE_STATES.has(fresh.gate_state) ? null : patch);
  if (own != null) return dispatchRuns.stampGateState(home, runId, unsettled, { own });
  return dispatchRuns.stampGateState(home, runId, (fresh, lease) => (dispatchRuns.everClaimed(fresh, lease) ? null : unsettled(fresh)), {});
}

function createWorker(host) {
  const missing = HOST_FUNCTIONS.filter((k) => typeof (host && host[k]) !== "function");
  if (missing.length) throw new Error(`createWorker: host is missing ${missing.join(", ")}`);
  const {
    err, out, annotateInFlight, checkProposals, cmdWorkRegate, cmdWorkRegateFlakes, cmdWorkStatus,
    codeWatchRef, dispatchAgentId, dispatchSatisfiableWorkItem, dispatchWorktreeDir,
    dispatchableQueuePage, dispatchedAgents, escalateParkedPipeline, factoryScopeSlug,
    gateCoveragePreview, integrationSatisfiability, isAgentId, loadFactoryDefinition,
    loadedCodeCommit, makeCodeMovedNotice, makeFactoryAvailabilityCheck, pollWorkRuns,
    reconcileCompletions, reconcileWithdrawnExecutions, renewLiveExecutions, replayAttestationDebts,
    resolveDir, retryOneEscalation, runGateAndIntegration, takeProjectWarning,
    targetRepoDispatchCfg, warnQueueProjectOnce, workerAlive,
  } = host;

  // PLAN: parse and validate every option, load and validate the factory and
  // its gh/publication satisfiability, and resolve the scope. Reads only — it
  // may print and read the graph/config, never write a file, the graph or a
  // lock. Returns an exit code (a refusal, already reported) or the plan.
  async function planWork(cfg, { values }) {

    // Scope: an explicit --project, else the queue.project pin the rest of the
    // read surface already honors, else the whole queue — a worker box is not
    // inherently single-repo, and each item is dispatched into ITS own repo
    // through the slug->path map. A factory can narrow the DEFAULT below, but
    // the scope token never bounds what a gate may judge: the factory's own
    // declared repo scope does (issue-spor-work-scope-union-factory-mismatch).
    const explicitSlug = values.project || cfg.get("work.project", null) || cfg.get("queue.project", null) || null;
    let slug = explicitSlug;
    // Numeric options are REJECTED, not silently replaced, when they aren't a
    // number in range: an unattended `spor work --max $N` with a typo'd $N would
    // otherwise quietly become an unbounded worker, and an explicit
    // `--retry-after 0` would quietly become ten minutes. `bad` collects the
    // problems so one run reports all of them.
    const bad = [];
    // The ceiling is not decoration: these become setTimeout delays, and Node
    // CLAMPS anything over 2**31-1 ms to 1ms — so `--interval 3000000` (an easy
    // slip when the config key beside it, work.intervalMs, is in MILLISECONDS)
    // would turn a monthly poll into a thousand-per-second spin. The config
    // fallback goes through the same range, since it reaches setTimeout by the
    // same route.
    const num = (flag, raw, { min, max, fallback }) => {
      const clamp = (v) => Math.min(max, Math.max(min, v));
      const safeFallback = Number.isFinite(Number(fallback)) ? clamp(Number(fallback)) : min;
      if (raw == null) return safeFallback;
      const v = String(raw).trim() === "" ? NaN : Number(raw);
      if (!Number.isFinite(v) || v < min || v > max) {
        bad.push(`--${flag} ${raw === "" ? "(empty)" : raw} — expected a number between ${min} and ${max}`);
        return safeFallback;
      }
      return v;
    };
    const DAY_S = 86400;
    const concurrency = num("concurrency", values.concurrency, { min: 1, max: 1000, fallback: cfg.getNum("work.concurrency", workLoop.WORK_DEFAULTS.concurrency) });
    const intervalMs = num("interval", values.interval, { min: 1, max: DAY_S, fallback: cfg.getNum("work.intervalMs", workLoop.WORK_DEFAULTS.intervalMs) / 1000 }) * 1000;
    const maxIntervalMs = num("max-interval", values["max-interval"], { min: 1, max: DAY_S, fallback: cfg.getNum("work.maxIntervalMs", workLoop.WORK_DEFAULTS.maxIntervalMs) / 1000 }) * 1000;
    const retryAfterMs = num("retry-after", values["retry-after"], { min: 0, max: 30 * DAY_S, fallback: cfg.getNum("work.retryAfterMs", workLoop.WORK_DEFAULTS.retryAfterMs) / 1000 }) * 1000;
    const runMaxMs = num("run-max", values["run-max"], { min: 0, max: 720, fallback: cfg.getNum("work.runMaxMs", workLoop.WORK_DEFAULTS.runMaxMs) / 3600000 }) * 3600000;
    const runIdleMs = num("run-idle", values["run-idle"], { min: 0, max: 43200, fallback: cfg.getNum("work.runIdleMs", workLoop.WORK_DEFAULTS.runIdleMs) / 60000 }) * 60000;
    const max = num("max", values.max, { min: 0, max: 1000000, fallback: 0 });
    // task-spor-gate-escalation-bounded-auto-retry: config-only, like the
    // classifier knobs (nudge.maxCalls, distill.timeoutMs) — no CLI flags, since
    // an unattended worker only ever needs to tune these once per box, not per
    // invocation. Malformed config falls back to the default (cfg.getNum's own
    // contract), never to an unbounded value: the backoff itself clamps to
    // [backoffMs, maxBackoffMs] regardless of what lands here.
    const escalationRetryMaxAttempts = Math.max(0, cfg.getNum("work.escalationRetryMaxAttempts", workLoop.WORK_DEFAULTS.escalationRetryMaxAttempts));
    const escalationRetryBackoffMs = Math.max(0, cfg.getNum("work.escalationRetryBackoffMs", workLoop.WORK_DEFAULTS.escalationRetryBackoffMs));
    const escalationRetryMaxBackoffMs = Math.max(escalationRetryBackoffMs, cfg.getNum("work.escalationRetryMaxBackoffMs", workLoop.WORK_DEFAULTS.escalationRetryMaxBackoffMs));
    // task-spor-work-loop-parked-reoffer-cap: config-only for the same reason —
    // how many identical `interrupted` results a parked gate pipeline may report
    // before the loop escalates it to a person (0 = re-offer without bound).
    const parkedReofferMax = Math.max(0, Math.floor(cfg.getNum("work.parkedReofferMax", workLoop.WORK_DEFAULTS.parkedReofferMax)));
    // `--restart-on-land` (work.restartOnLand): exit cleanly, once the in-flight
    // work settles, when the checkout this worker loaded its code from moves past
    // that code — for a self-hosting factory whose worker sits on the checkout
    // its own pipelines land onto, run under a supervisor that restarts it. Opt-in
    // only; the flag wins over the config key.
    const restartOnLand = values["restart-on-land"] ? true : cfg.getBool("work.restartOnLand", false);
    // The acceptance policy (task-spor-work-accept-policy): which readiness
    // classifications this loop may pick up. `ready` (the default) dispatches
    // only items a person explicitly stamped agent-ready; `open` restores the
    // original looser pickup (everything except readiness:human — that floor is
    // WORKERS.md §3's and no policy value moves it). Resolution: --accept >
    // SPOR_WORK_ACCEPT > repo .spor.json > user config > default — the flag is
    // checked here, everything else rides the ordinary cascade. An unknown value
    // REFUSES to start the worker, same posture as the numeric options above: a
    // typo'd policy on an unattended box must not silently become either one.
    const acceptRaw = values.accept != null ? values.accept : cfg.get("work.accept", workLoop.WORK_DEFAULTS.accept);
    const accept = String(acceptRaw).trim().toLowerCase();
    if (!workLoop.WORK_ACCEPT_POLICIES.includes(accept)) {
      bad.push(`${values.accept != null ? "--accept" : "work.accept"} ${String(acceptRaw).trim() === "" ? "(empty)" : acceptRaw} — expected one of: ${workLoop.WORK_ACCEPT_POLICIES.join(", ")}`);
    }
    if (bad.length) {
      for (const b of bad) err(`spor work: ${b}`);
      return 1;
    }

    // This box's own agent identity, for the assignee filter below
    // (issue-spor-auto-route-additive-assignment-two-assignees): the same
    // precedence `spor dispatch` resolves `identityAgent` from (--as, else
    // dispatch.agent) — an unconfigured box has no identity to compare against,
    // so the filter stays a no-op there rather than guessing. Unlike
    // `cmdDispatch`, which validates `--as` up front and refuses loudly on a
    // malformed id, `spor work` only reaches that validation per item, inside
    // the per-node `cmdDispatch` call — AFTER this filter would already have
    // run. A malformed value here must not silently misclassify every item
    // genuinely assigned to a real agent as "assigned to another agent" (never
    // equal to the garbage string) and skip it forever with a misleading
    // reason, hiding the loud "invalid --as agent id" refusal `cmdDispatch`
    // would otherwise give on the first attempt — so an unrecognized shape
    // disables the filter instead of feeding it.
    const selfAgentRaw = values.as || dispatchAgentId(cfg) || null;
    const selfAgent = selfAgentRaw && isAgentId(selfAgentRaw) ? selfAgentRaw : null;

    // The GATE PIPELINE (task-spor-work-gate-pipeline), opt-in and graph-resident:
    // with no factory declared the loop runs exactly as it shipped. A declared one
    // that cannot be read or does not validate REFUSES to start the worker —
    // gates are enforcement, and the one thing a mistyped definition must never
    // produce is a worker that silently accepts everything.
    const factoryId = values.factory || cfg.get("work.factory", null) || null;
    let factory = null;
    if (factoryId) {
      const loaded = await loadFactoryDefinition(cfg, factoryId);
      if (!loaded.factory) {
        err(`spor work: the factory definition '${factoryId}' cannot be used:`);
        for (const e of loaded.errors) err(`  ${e}`);
        err("  a worker does not run ungated on a definition it could not read — fix the factory node, or drop --factory/work.factory.");
        return 1;
      }
      factory = loaded.factory;
      // task-spor-propose-gh-capability-satisfiability: `gh` is a declared
      // capability, checked through the SAME machine-profile satisfiability
      // layer as a profile's harness/mcp/skills/plugins
      // (dec-spor-machine-profile-satisfiability), not a one-off startup PATH
      // probe that kills the whole worker. A mixed fleet may point several
      // boxes at the same propose factory/queue and only some have gh — a box
      // that can't ever land a proposal should idle (skipping every candidate
      // here, visibly, in `spor work --status`, and leaving them for a
      // capable box) rather than crash-loop under a service supervisor. Warn
      // once, loudly, so an operator watching THIS box's own log still learns
      // why nothing here ever dispatches; the per-item check below is what
      // actually stops a claim. `proposeIntegrationPR`/`ghPrStatus` keep their
      // own `hasCmd("gh")` checks as the backstop at the point `gh` is
      // actually invoked — the guarantee must never rest on this check having
      // run.
      // A read: the probe is not persisted here (the plan phase writes nothing);
      // the per-item availability check at dispatch time persists its own.
      const startupGh = integrationSatisfiability(cfg, factory, { persistProbe: false });
      if (!startupGh.ok) {
        err(`spor work: factory '${factoryId}' ${factory.integration && factory.integration.mode === "propose" ? "declares integration mode 'propose'" : "declares a 'ci' suite"}, but ${startupGh.reasons[0]}`);
        err("  every candidate under this factory will be skipped here (see 'spor work --status') until gh is available, or run this worker on a box that has it.");
      }
      // Invalid declarations remain fatal. Runtime store/remote outages are
      // item-level refusals before claim, visible in status and retried boundedly.
      const startupPublish = candidatePublish.publishSatisfiability(factory, {
        graphHome: cfg.userConfigHome(),
        mode: cfg.mode(),
        // Checked without creating the store or its .gitignore line — the plan
        // phase writes nothing; the first real publish makes both.
        readOnly: true,
        // The checkouts this machine actually knows about (`dispatch.repos`,
        // per-machine and never committable), narrowed to what the factory
        // declares. A repo we hold no path for is not a refusal — we could not
        // prove a failure — and the check says so rather than guessing.
        repoPaths: Object.fromEntries(
          (factory.repos || []).map((r) => [r, (cfg.get("dispatch.repos", {}) || {})[r]]).filter(([, dir]) => dir)
        ),
      });
      for (const w of startupPublish.warnings) err(`spor work: ${w}`);
      if (startupPublish.configurationErrors.length) {
        err(`spor work: factory '${factoryId}' has invalid publication configuration:`);
        for (const e of startupPublish.configurationErrors) err(`  ${e}`);
        return 1;
      }
      for (const e of startupPublish.unavailable) err(`spor work: ${e} — affected items will be skipped before claim and retried (see 'spor work --status').`);

    }
    // `dispatch.claudeLaunchMode` names a launch mode that no longer exists
    // (the native `claude --bg` launch is retired, task-spor-deprecate-native-
    // bg-dispatch): every run this loop dispatches is SUPERVISED. Ignoring a knob
    // the operator set is fine; ignoring it SILENTLY is not — say so once, here,
    // where an operator reading the worker's log will see it (cmdDispatch stays
    // quiet for `supervisedOnly` dispatches). Same wording for --print and a real
    // run.
    const configuredLaunchMode = cfg.get("dispatch.claudeLaunchMode", null) || null;
    if (configuredLaunchMode === "native-background") {
      err("spor work: dispatch.claudeLaunchMode 'native-background' is retired (the native claude --bg launch), so this worker ignores it — every run it dispatches (implementers, agent-review gates, fix cycles, rescues) is launched SUPERVISED (claude -p under the supervisor) so it can be followed, judged and gated. Remove the key to silence this.");
    } else if (configuredLaunchMode && configuredLaunchMode !== "supervised") {
      err(`spor work: dispatch.claudeLaunchMode '${configuredLaunchMode}' is not recognized (supervised is the only launch mode) — ignoring it; this worker always launches supervised.`);
    }
    // The factory's repo scope (issue-spor-work-scope-union-factory-mismatch).
    // Two distinct jobs, and originally only the second was load-bearing:
    //   - the queue SCOPE TOKEN (`slug`), which decides how wide a page we
    //     read. A single-repo factory with no explicit --project defaults it to
    //     that repo's slug — the token an operator would type, union semantics
    //     and all — rather than reading every project's queue and discarding
    //     most of it. Deliberately NOT the `repo-<slug>` node-id form: that
    //     pins a single repo only when such a node EXISTS, and silently yields
    //     an empty queue when it doesn't, which is a stalled worker with no
    //     message. A too-wide token costs a filtered candidate; a wrong-narrow
    //     one costs the work.
    //   - the GUARD below, which bounds the factory: whatever the token unions
    //     in, only items stamped with a repo this factory declares are
    //     candidates. That was the ORIGINAL fix (issue-spor-work-scope-union-
    //     factory-mismatch) — the scope token is a read hint, the declared
    //     repos are the contract.
    // BOTH reload every pass now (task-spor-work-factory-reload-extend-to-repo-
    // scope): a first cut of this fix widened only the guard (`factoryRepos`/
    // `localFactoryGraph`, `let` bindings the `candidates()` closure reads
    // live) and left `slug` frozen at its startup value, on the theory that it
    // is "just" a read hint. That theory doesn't survive contact with the most
    // common real edit — a single-repo factory later widened to a sibling
    // repo: `slug` had auto-narrowed to that sole repo at startup, so
    // `dispatchableQueuePage(cfg, slug, ...)` below never even FETCHES the
    // newly-declared repo's items — the guard would happily admit them, but
    // they never reach it. So `slug` is re-derived the SAME way inside
    // `reloadFactory`, under the same `!explicitSlug` guard (an operator's own
    // `--project` is never overridden), whenever `factoryRepos` actually
    // changes — see the repo-scope-changed branch below.
    // A declared repo that names nothing in this graph is the quiet failure mode
    // of the whole feature: every item is out of scope, so the worker reads an
    // empty page (or filters the whole one away) and idles with nothing to say.
    // Say so where an operator is watching. A WARNING, not a refusal: a repo
    // whose identity node does not exist yet is not a typo. In LOCAL mode the
    // graph is right here (projectKnown); in REMOTE mode the server answers the
    // same question — GET /v1/queue?project=<repo> echoes a zero-match token as
    // the additive `project_warning` string
    // (task-spor-remote-next-print-project-warning) — so one bounded, fail-open
    // probe per declared repo asks it. The warning line is the SAME in both
    // modes (norm-spor-cli-mode-parity); a dead server, an error, or an older
    // server that omits the field says nothing here and falls back to the
    // loop's own scope-starvation notice. Deduped PER REPO across the whole
    // run (not per poll): `checkFactoryRepoScope` below is only re-invoked when
    // the reloaded factory's `repos:` actually changed, so a factory that never
    // edits its scope warns exactly once, same as the old startup-only check —
    // it is the CHANGE that re-runs the check, not the poll timer.
    const unknownRepoWarning = (r) => `warning: factory '${factoryId}' declares repo '${r}', which names no repo or project in this graph — items stamped with it will never be found.`;
    const warnedUnknownFactoryRepos = new Set();
    const warnUnknownFactoryRepoOnce = (r) => {
      if (warnedUnknownFactoryRepos.has(r)) return;
      warnedUnknownFactoryRepos.add(r);
      err(unknownRepoWarning(r));
    };
    // Loaded fresh whenever `repos:` changes (local mode only — the graph is not
    // "cheaply available" remotely) and reused to resolve historical `project:`
    // stamps through `graph.projectAliases` when checking a factory's declared
    // repo scope (task-spor-factory-alias-resolution-local-mode): a legacy
    // stamp (`substrate`) and a current-slug declaration (`repos: ["spor"]`)
    // both resolve to the same repo node's canonical id there. Stays null in
    // remote mode or on an unreadable graph, which is exactly the
    // byte-identical raw-stamp-comparison fallback gates.repoScope/inRepoScope
    // already have.
    const checkFactoryRepoScope = async (repos) => {
      if (!repos.length) return null;
      let graph = null;
      if (cfg.mode() === "local") {
        try {
          const graphLib = require(path.join(ROOT, "lib", "graph.js"));
          graph = graphLib.loadGraph(cfg.nodesDir());
          for (const r of repos) {
            if (!graphLib.projectKnown(graph, r)) warnUnknownFactoryRepoOnce(r);
          }
        } catch {
          /* an unreadable graph is the queue read's problem to report, not this check's */
          graph = null;
        }
      } else if (cfg.mode() === "remote") {
        for (const r of repos) {
          try {
            const res = await remote.get(cfg, `/v1/queue?project=${encodeURIComponent(r)}&limit=1`, { timeoutMs: 3000 });
            const warning = res.ok ? takeProjectWarning(res.json) : null;
            if (!warning) continue;
            // The server's text is the authoritative answer, so print it VERBATIM
            // (the acceptance: byte-matching what `spor next --project <typo>`
            // prints), then the factory-shaped context line local mode prints. The
            // verbatim line goes through the once-per-token printer so a
            // single-repo factory — whose page read is scoped to this same repo and
            // carries the same field — says it once, while a multi-repo factory —
            // whose page read is UNSCOPED and never sees it — still says it per repo.
            warnQueueProjectOnce(r, warning);
            warnUnknownFactoryRepoOnce(r);
          } catch {
            /* fail-open: an unreachable server is the queue read's problem to report */
          }
        }
      }
      return graph;
    };
    let factoryRepos = (factory && factory.repos) || [];
    if (!explicitSlug) slug = factoryScopeSlug(factoryRepos);
    let localFactoryGraph = await checkFactoryRepoScope(factoryRepos);
    // The change-detection key `reloadFactory` compares against below, so the
    // (comparatively expensive — a full local graph load, or a remote round
    // trip per declared repo) recompute runs only when `repos:` itself moved,
    // never on every poll.
    let factoryReposKey = JSON.stringify(factoryRepos);

    // Passed straight through to every dispatch this loop makes. Deliberately NOT
    // --force: a loop that forces past the duplicate/resolved guards is exactly
    // the runaway a pull worker must not be.
    const passthrough = {};
    // The harness-specific flags come from the harness module's own list, so a
    // new one rides without a second edit here.
    for (const k of ["profile", "model", "as", "template", "dir"].concat(Object.keys(dispatchHarnesses.HARNESS_OPTION_FLAGS))) {
      if (values[k]) passthrough[k] = values[k];
    }
    // NOT --no-claim either: the lease is the ONLY thing that keeps two pull
    // workers off one node (dec-cc-task-claim-lease), so a loop that dispatches
    // without one is exactly the collision this design rules out. A human aiming
    // one agent at one node can still opt out with `spor dispatch --no-claim`.
    for (const k of ["worktree", "no-worktree", "no-brief", "full", "allow-person-token"]) {
      if (values[k]) passthrough[k] = true;
    }

    // Read before `candidates` closes over it: `--print` calls that closure
    // before the loop starts, so this cannot be declared further down.
    const home = cfg.userConfigHome();
    return { values, explicitSlug, slug, concurrency, intervalMs, maxIntervalMs, retryAfterMs, runMaxMs, runIdleMs, max, escalationRetryMaxAttempts, escalationRetryBackoffMs, escalationRetryMaxBackoffMs, parkedReofferMax, restartOnLand, accept, selfAgentRaw, selfAgent, factoryId, factory, checkFactoryRepoScope, factoryRepos, localFactoryGraph, factoryReposKey, passthrough, home };
  }

  // BIND the plan's live state — the factory binding a per-pass reload swaps,
  // the repo scope and page token that follow it, the candidate page and the
  // availability check — shared by the preview and the loop, so `--print`
  // reads the page exactly the way the loop would.
  function bindWork(cfg, plan) {
    const { values, explicitSlug, concurrency, intervalMs, maxIntervalMs, retryAfterMs, runMaxMs, runIdleMs, max, escalationRetryMaxAttempts, escalationRetryBackoffMs, escalationRetryMaxBackoffMs, parkedReofferMax, restartOnLand, accept, selfAgentRaw, selfAgent, factoryId, checkFactoryRepoScope, passthrough, home } = plan;
    let { slug, factory, factoryRepos, localFactoryGraph, factoryReposKey } = plan;
    const checkAvailability = makeFactoryAvailabilityCheck(cfg, { passthrough, baseMs: intervalMs, maxMs: maxIntervalMs, persistProbe: !(values.print || values["dry-run"]) });

    // The page width the last pass NEEDED, carried across polls
    // (task-spor-queue-api-offset-paging). A worker whose only eligible work sits
    // below a page of items it may not take widens to reach it — and without this
    // it re-walks that ladder from the base width on every poll, paying several
    // GET /v1/queue round-trips every 30s to reach the same item. Carried, that
    // width is read in ONE request — the ladder does not widen past what the
    // server serves in a single page, precisely so this carried width stays a
    // one-read poll; and because dispatchableQueuePage hands back only the width
    // it actually needed, a queue whose front becomes dispatchable again narrows
    // straight back to the base.
    const pageWidth = {};

    // The node ids of every open pipeline the last resume scan saw (pendingGates
    // below), so candidate selection keeps them out while their journal is
    // parked. Refreshed on every scan.
    let openNodes = new Set();
    const candidates = async ({ cooling = null } = {}) => {
      // Items already being worked by an agent on THIS box — this loop's earlier
      // runs, a hand-run `spor dispatch`, another loop — are not candidates. The
      // same-machine guard would refuse them anyway; skipping them here keeps a
      // refusal (and a cooldown entry) out of the status surface for something
      // that is simply already being done.
      const agents = dispatchedAgents(cfg);
      // ...and neither are items ANOTHER live worker on this box is gating. The
      // loop already subtracts its OWN gating slots, but nothing else would stop
      // a second worker here: a gated run is terminal, so it has no live agent
      // for the in-flight guard to see, and an unenforced `reported` one has
      // already handed its lease back. Both workers would then dispatch the node
      // the first one's gate is still judging.
      // ...nor an item whose gate pipeline is OPEN on this box — parked on a
      // yield, or left running by a dead worker — which the resume scan below
      // will re-offer (openNodes, task-spor-delete-loop-resume-machinery-
      // after-workflow-stages): the slot is freed while a journal is parked,
      // so the node's exclusion rides the scan's reading instead.
      const gating = factory ? new Set([...workLoop.gatingNodeIds(workLoop.readWorkerStatuses(home, { alive: workerAlive })), ...openNodes]) : null;
      // What makes an item worth a slot THIS pass, evaluated ON THE PAGE so the
      // fetch can widen past a page that holds none (the starvation the fixed
      // page size otherwise makes permanent — see dispatchableQueuePage). The
      // loop's cooldowns are part of it (`cooling`, passed in per pass): a
      // deterministic refusal — a profile this box cannot satisfy — cools the
      // same item forever, so without this the page would stop widening at that
      // item and everything ranked below it would starve exactly as before. A
      // page whose only eligible items are cooling is a pass with nothing to
      // dispatch, which is precisely when a deeper read is free.
      const scope = gatesKernel.repoScope(factoryRepos, localFactoryGraph);
      const eligible = (it) =>
        !(agents.get(it.id) || []).length &&
        !(gating && gating.has(it.id)) &&
        !(cooling && cooling(it.id)) &&
        workLoop.pageEligible(it, { accept, repos: factoryRepos, scope, graph: localFactoryGraph, selfAgent });
      // Page deeper than the default when the cap is high: the page is filtered
      // again below (in-flight) and again by the loop (readiness, cooldowns), so
      // a page the size of the cap could not fill it.
      // Page deeper when a factory scope will discard part of it: the queue is
      // ranked across the whole scope token, so a grouping's sibling repos can
      // otherwise fill the page and starve a worker that has eligible work
      // further down.
      const page = await dispatchableQueuePage(cfg, slug, Math.max(factoryRepos.length ? 50 : 25, concurrency * 4), { eligible, width: pageWidth });
      const items = annotateInFlight(page, agents, true).items;
      if (!gating) return items;
      return gating.size ? items.filter((it) => !gating.has(it.id)) : items;
    };

    // PREVIEW (`--print` / `--dry-run`): what the loop would do, with none of
    // its side effects.
    async function previewWork() {
      // The worker's own diagnostic preview (task-spor-worker-preflight-
      // validation): the effective tenant and which selector chose it, the write
      // posture every dispatch this loop makes will carry, the workspace
      // isolation each in-scope repo resolves to, and the gate coverage — armed
      // or skipped, with the reason. It reads the same resolution path the real
      // loop does and performs none of its side effects (no claim, no dispatch,
      // no worktree, no config write, no credential echoed).
      out(`tenant:  ${preflight.tenantLine(preflight.describeTenant(cfg))}`);
      out(`project: ${slug || "(all projects)"}`);
      out(`accept:  ${accept} — ${accept === "open" ? "any queue item except readiness:human (untriaged included)" : "only items explicitly stamped agent-ready (--accept open for the looser pickup)"}`);
      out(`agent:   ${selfAgent
        ? selfAgent
        : selfAgentRaw
          ? `(ignoring '${selfAgentRaw}' — not a valid agent-<slug> id; the assignee filter is disabled until it is)`
          : "(none configured — an item another agent already holds is not filtered out; set dispatch.agent or pass --as)"}`);
      out(`loop:    concurrency ${concurrency}, interval ${intervalMs / 1000}s, backoff to ${maxIntervalMs / 1000}s, retry refused after ${retryAfterMs / 1000}s, stop following a run after ${runMaxMs / 3600000}h${runIdleMs > 0 ? `, stop a run idle for ${runIdleMs / 60000}m` : ""}${max ? `, stop after ${max}` : ""}`);
      out(`status:  ${workLoop.workDir(cfg.userConfigHome())}`);
      // The posture this worker hands to every dispatch it makes. Each dispatch
      // resolves its OWN harness from the item's profile and refuses when the
      // posture that resolves there is not unattended, so the useful thing to say
      // here is what is being passed and which built-in harnesses that satisfies.
      const postureFlags = Object.entries(dispatchHarnesses.harnessOptionFlags("posture"))
        .filter(([flag]) => values[flag])
        .map(([flag]) => `--${flag} ${values[flag]}`);
      const postureOptions = {};
      for (const [flag, option] of Object.entries(dispatchHarnesses.harnessOptionFlags("posture"))) {
        if (values[flag]) postureOptions[option] = values[flag];
      }
      const postureFit = { unattended: [], refused: [] };
      for (const adapter of dispatchHarnesses.harnesses({ cfg })) {
        if (adapter.declaration) continue; // operator-bound; this client expresses no posture for it
        const v = preflight.checkWritePosture({ adapter, options: postureOptions, unattended: true, harnessId: adapter.id });
        (v.ok ? postureFit.unattended : postureFit.refused).push(adapter.id);
      }
      out(`posture: ${postureFlags.length ? postureFlags.join(" ") : "(none passed)"} — unattended on ${postureFit.unattended.join(", ") || "no built-in harness"}${postureFit.refused.length ? `; a ${postureFit.refused.join("/")} profile would be REFUSED before its claim` : ""}`);
      // Workspace isolation, per in-scope repo. `dispatch.worktreeSetup` alone
      // never enables `dispatch.worktree` — the mismatch is reported, not
      // interpreted (the Dartlane pilot's shared-checkout failure).
      const scopeRepos = (factoryRepos.length ? factoryRepos : slug ? [slug] : Object.keys(cfg.get("dispatch.repos", {}) || {})).slice(0, 8);
      if (!scopeRepos.length) out(`workspace: no repo mapped yet — 'spor repos add <slug> <path>' (each item dispatches into its own repo)`);
      for (const r of scopeRepos) {
        const rd = resolveDir(cfg, { dir: null, slug: r });
        if (!rd.dir) {
          out(`workspace: ${r} — not mapped on this box ('spor repos add ${r} <path>'); every item stamped with it would refuse`);
          continue;
        }
        const tcfg = targetRepoDispatchCfg(rd.dir);
        const standing = loadConfig({ cwd: rd.dir, env: process.env });
        const setup = tcfg.worktreeSetup != null ? tcfg.worktreeSetup : standing.get("dispatch.worktreeSetup", null);
        const isolated = values["no-worktree"]
          ? false
          : !!(values.worktree || (tcfg.worktree != null ? tcfg.worktree : !!standing.get("dispatch.worktree", false)));
        const plan = preflight.planWorkspace({
          repoDir: rd.dir,
          worktreeDir: dispatchWorktreeDir(rd.dir, "<node-id>"),
          useWorktree: isolated,
          worktreeSetup: setup,
          explicitNoWorktree: !!values["no-worktree"],
        });
        out(
          `workspace: ${r} -> ${rd.dir} — ${isolated ? "isolated worktree per dispatch" : "SHARED checkout (dispatch.worktree off): concurrent writers are refused, not isolated"}` +
            (plan.setupOrphaned ? "; dispatch.worktreeSetup is declared but does NOT enable isolation — set dispatch.worktree true" : "")
        );
      }
      if (factory) {
        out(`factory: ${factoryId}${factory.revision ? ` @ ${factory.revision.slice(0, 12)}` : ""} — trusted ref ${factory.trustedRef}${factory.protectedPaths.length ? `, protected ${factory.protectedPaths.join(" ")} -> ${factory.testLaneProfile}` : ""}`);
        out(`  judges: ${factoryRepos.length ? `repo(s) ${factoryRepos.join(", ")} — items stamped with any other repo are skipped` : "any repo (no 'repos' declared and no project stamp on the factory node)"}`);
        for (const g of factory.gates) {
          const how =
            g.kind === "command" ? `\`${g.command}\`` : g.kind === "agent-review" ? `review under ${g.profile}` : `approval${g.risk.length ? ` when ${g.risk.join("/")}` : " (always)"}`;
          out(`  gate ${g.id}  ${g.kind}  ${how}${g.cycles ? `  (up to ${g.cycles} fix cycle${g.cycles === 1 ? "" : "s"})` : ""}${g.source !== "inline" ? `  [${g.source}]` : ""}`);
          // Armed-or-skipped, with the reason — the coverage question an operator
          // actually has. A command gate runs on every change; a human gate arms
          // only on its declared risk classes; an agent-review gate is only
          // coverage at all if THIS box can dispatch its profile read-only.
          out(`    ${await gateCoveragePreview(cfg, g)}`);
        }
        if (factory.rescue) out(`  rescue: under ${factory.rescue.profile}, up to ${factory.rescue.attempts} attempt${factory.rescue.attempts === 1 ? "" : "s"} before any human escalation`);
        else out(`  rescue: none declared — a gate whose fix cycles are spent escalates straight to a person`);
        const ghVerdict = integrationSatisfiability(cfg, factory, { persistProbe: false });
        if (!ghVerdict.ok) out(`  integration: mode 'propose' — UNSATISFIABLE here: ${ghVerdict.reasons[0]}`);
        else if (factory.integration) {
          out(`  integration: mode '${factory.integration.mode}' onto ${factory.integration.targetRef} — armed once every gate above has passed`);
        } else out(`  integration: none declared — a passing pipeline lands nothing; the branch waits for a person`);
      } else {
        out(`factory: none — the loop runs bare (declare one with --factory <id> or work.factory)`);
      }
      const policySkips = [];
      const cands = workLoop.selectWorkCandidates(await candidates(), { accept, repos: factoryRepos, graph: localFactoryGraph, selfAgent, onSkip: (it, reason, kind) => policySkips.push({ it, reason, kind }) });
      if (!cands.length) out("queue:   nothing dispatchable right now");
      else {
        const available = [];
        const unavailable = [];
        for (const it of cands) {
          const verdict = await checkAvailability(factory, it);
          if (verdict.ok) available.push(it);
          else unavailable.push({ it, reason: verdict.reason });
        }
        out(`queue:   ${available.length} candidate(s); this pass would take the first ${Math.min(concurrency, available.length)}`);
        for (const [i, it] of available.entries()) {
          out(`  ${i < concurrency ? "->" : "  "} ${it.id}  ${it.readiness || "untriaged"}  ${it.title || it.summary || ""}`.slice(0, 160));
        }
        for (const { it, reason } of unavailable.slice(0, workLoop.SKIP_LOG_CAP)) out(`  skip ${it.id} — ${reason}`);
        if (unavailable.length > workLoop.SKIP_LOG_CAP) out(`  ...and ${unavailable.length - workLoop.SKIP_LOG_CAP} more unavailable items`);
      }
      // Same treatment as the loop's own log and `--status`: a widened page can
      // hold hundreds of skips, and a preview that scrolls them all off the
      // screen hides its own answer.
      for (const { it, reason } of policySkips.slice(0, workLoop.SKIP_LOG_CAP)) out(`  skip ${it.id}  ${it.readiness || "untriaged"}  ${reason}`.slice(0, 160));
      if (policySkips.length > workLoop.SKIP_LOG_CAP) {
        out(`  ...and ${policySkips.length - workLoop.SKIP_LOG_CAP} more skipped — ${workLoop.summarizeSkips(policySkips.slice(workLoop.SKIP_LOG_CAP).map((p) => ({ reason: p.reason, kind: p.kind })))}`);
      }
      out(`\nnothing was launched (--print). Each item would go through 'spor dispatch --node <id>', whose guards decide.`);
      return 0;
    }

    // EXECUTE: the one-shot re-gate verbs, or the loop itself.
    async function executeWork() {

    // `--regate <run>`: re-judge one refused run under this factory and exit —
    // no polling, no dispatching (task-spor-work-regate).
    if (values.regate) {
      return cmdWorkRegate(cfg, values, { factory, factoryId, slug, passthrough, warn: (line) => err(line), runMaxMs, home });
    }
    if (values["regate-flakes"]) {
      return cmdWorkRegateFlakes(cfg, values, { factory, factoryId, slug, passthrough, warn: (line) => err(line), runMaxMs, home, factoryRepos });
    }

    const workerId = crypto.randomUUID();
    // run id -> the pipeline lease token this worker's own claim minted for
    // it (the gate pass or the parked escalation): markGate's `own`.
    const pipelineTokens = new Map();
    // Sweep aged-out worker records now: pruning otherwise only happens inside a
    // `--status` read, so a box running `spor work --once` on a cron and never
    // reading the status back would accumulate one record per invocation forever.
    workLoop.readWorkerStatuses(home, { alive: workerAlive });
    const control = { stopping: false, reason: null, wake: () => {} };
    // A service manager stops a worker with a signal, so a signal must reach the
    // loop mid-backoff rather than at the end of it: wake() collapses the pending
    // sleep. A SECOND signal is the operator insisting — exit immediately.
    const onSignal = (sig) => {
      if (control.stopping) process.exit(130);
      control.stopping = true;
      control.reason = `stopped on ${sig}`;
      // Straight to stderr, NOT through err(): a signal arriving mid-dispatch
      // would otherwise land in that dispatch's captured lines and could become
      // the item's recorded skip reason.
      process.stderr.write(`work: ${sig} — not picking up new work. In-flight runs keep going and self-report ('spor runs').\n`);
      control.wake();
    };
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => onSignal(sig));

    // Latched: a persistently unreadable harness listing warns about each held
    // run ONCE, not once per poll — the same sentence `spor runs` prints once per
    // invocation, not 11k lines a day into a service log.
    const warned = new Set();
    const warn = (line) => {
      if (warned.has(line)) return;
      warned.add(line);
      err(line);
    };

    out(`work: worker ${workerId.slice(0, 8)} — ${slug || "all projects"}, accept ${accept}, concurrency ${concurrency}, poll ${intervalMs / 1000}s${max ? `, stopping after ${max} dispatch(es)` : ""}`);
    if (factoryRepos.length) out(`work: factory ${factoryId} judges repo(s) ${factoryRepos.join(", ")} — items from any other repo are skipped, not gated`);
    // Reloaded every pass from here on (task-spor-work-reload-factory-
    // definition-per-pass) — say which revision this is so a later `--status`
    // reading a different one is legible against this line.
    if (factory) out(`work: factory ${factoryId} loaded @ ${(factory.revision || "?").slice(0, 12)} — re-read every poll pass; an edit takes effect on the next pass, a bad one is rejected and logged here`);
    // The completion boundary this worker will use (FACTORY-IMPLEMENTATION-
    // STAGE.md §2.4 V6): logged at startup so an operator's choice — completing
    // at acceptance before the change is on the target ref — is visible.
    if (factory && factory.completion && factory.completion.by === "controller") {
      out(
        `work: completion by the CONTROLLER at the '${factory.completion.after}' boundary — implementers submit candidates; the resolving edge and terminal status are written here once the gates${factory.completion.after === "integration" ? " and the integration stage" : ""} pass` +
          (factory.completion.after === "gates" && factory.integration ? " (integration runs AFTER completion: a landing failure files a relates-to item and never demotes)" : "")
      );
    }
    out(`work: status at ${workLoop.workerStatusPath(home, workerId)}  ('spor work --status')`);
    // What code this worker runs, said once up front and re-checked each pass
    // (task-spor-work-announce-lib-commit-and-notice-main-moved): a long-running
    // worker keeps the lib/bin it loaded, so a fix that lands on main after
    // startup does not reach its pipelines until it is restarted.
    const loadedCode = loadedCodeCommit(ROOT);
    out(
      loadedCode
        ? `work: running ${ROOT} at ${loadedCode.commit}${loadedCode.branch ? ` (${loadedCode.branch})` : ""} — a worker keeps the code it loaded; restart it after a land you want it to run`
        : `work: running @sporhq/spor ${require(path.join(ROOT, "package.json")).version} from ${ROOT} — a worker keeps the code it loaded; restart it after an upgrade you want it to run`
    );
    // The ref watched is the factory's integration target when it resolves in
    // this checkout (a self-hosting factory lands onto it), else the branch the
    // code was loaded from — never bare HEAD while a branch is known, so a branch
    // switch or bisect in a linked worker checkout is not mistaken for a land.
    const watchRef = codeWatchRef(loadedCode, { root: ROOT, targetRef: factory && factory.integration ? factory.integration.targetRef : null });
    if (loadedCode && watchRef) out(`work: watching ${watchRef} in ${ROOT} for a commit that moves past ${loadedCode.commit}`);
    const noticeCode = makeCodeMovedNotice(loadedCode, { root: ROOT, log: (line) => out(line), ref: watchRef });
    // The flag needs a checkout to watch: an npm install never moves under the
    // worker (it is replaced by an upgrade), so say once that it is inert.
    if (restartOnLand && !loadedCode) out(`work: --restart-on-land has nothing to watch — ${ROOT} is not a source checkout; the worker runs until stopped`);
    const final = await workLoop.runWorkLoop({
      opts: {
        workerId, project: slug, accept, repos: factoryRepos, graph: localFactoryGraph, selfAgent, concurrency, intervalMs, maxIntervalMs, retryAfterMs, parkedReofferMax, max, once: !!values.once, factory: factoryId, factoryRevision: factory && factory.revision, restartOnLand,
        // The pid-reuse guard for this record: a SIGKILLed worker leaves no
        // stopped_at, and a bare pid probe would read its recycled pid as this
        // worker still running (the same identity check the run store makes).
        startedTicks: processIdentity.mintIdentity().ticks,
      },
      control,
      deps: {
        noticeCode,
        candidates,
        // Refuse BEFORE any side effect if this machine can't satisfy the
        // loaded factory's integration requirement (task-spor-propose-gh-
        // capability-satisfiability) — mirrors cmdDispatch's own profile-
        // satisfiability refusal (dec-spor-machine-profile-satisfiability):
        // never call through to dispatchWorkItem/cmdDispatch, so no lease is
        // ever established for an item this box can never finish landing. The
        // loop's existing refusal-cooldown machinery does the rest — the same
        // path any other unsatisfiable-profile refusal already takes.
        dispatch: (item) => dispatchSatisfiableWorkItem(cfg, item, passthrough, { checkAvailability, factory, home, log: (line) => out(line) }),
        pollRuns: (ids) => pollWorkRuns(cfg, ids, { maxAgeMs: runMaxMs, idleMs: runIdleMs, warn }),
        publish: (status) => workLoop.writeWorkerStatus(home, status),
        log: (line) => out(line),
        // Present only when a factory resolved, so a bare worker's deps — and its
        // behavior — are byte-identical to what shipped.
        ...(factory
          ? {
              // task-spor-work-reload-factory-definition-per-pass: re-read and
              // re-validate the factory definition once per poll pass, through
              // the SAME loadFactoryDefinition a starting worker uses, so any
              // future validation it grows (schema changes, a new stage) is
              // honored here for free. On a clean parse, swap the outer `factory`
              // binding to the freshly-built object — every closure above and
              // below reads that SAME `let` binding, so a fix cycle, a fresh
              // dispatch or a newly-gating item picks it up on the very next use,
              // with no restart. On a bad edit, the binding is left untouched: a
              // worker never runs ungated on a definition it could not read any
              // more than it would have refused to START on one
              // (dec-spor-gates-enforced-in-code-factory-is-data) — it keeps
              // enforcing the last one that DID parse, and the loop surfaces the
              // rejected edit's errors in `--status` instead. This can never
              // rewrite a pipeline already in flight: `deps.gate` below closes
              // over `factory` at the moment IT is called (pipeline start), which
              // copies the reference into that call's own options object — a
              // later reassignment here does not reach back into an object
              // already handed to a running pipeline.
              reloadFactory: async () => {
                const loaded = await loadFactoryDefinition(cfg, factoryId);
                if (loaded.factory) {
                  factory = loaded.factory;
                  // task-spor-work-factory-reload-extend-to-repo-scope: candidate
                  // repo-scope selection reloads too, not just the gate knobs
                  // above — but only when `repos:` actually changed, so an
                  // unrelated edit (reruns, isolate, serialize) never pays for a
                  // full local graph reload / remote round trip it doesn't need.
                  // `factoryRepos`/`localFactoryGraph` are `let` bindings the
                  // `candidates()` closure reads live, so reassigning them here
                  // reaches the very next poll's page read with no restart.
                  const newRepos = factory.repos || [];
                  const newKey = JSON.stringify(newRepos);
                  if (newKey !== factoryReposKey) {
                    factoryReposKey = newKey;
                    factoryRepos = newRepos;
                    localFactoryGraph = await checkFactoryRepoScope(factoryRepos);
                    // The queue-fetch scope TOKEN needs the SAME re-derivation
                    // `slug` got at startup (see the comment above), or a
                    // single-repo factory widened to a sibling repo never even
                    // FETCHES that repo's items — the guard above would admit
                    // them, but dispatchableQueuePage(cfg, slug, ...) below
                    // never returns them in the first place. Never touches an
                    // operator's own explicit --project.
                    if (!explicitSlug) slug = factoryScopeSlug(factoryRepos);
                  }
                  // Handed back on EVERY ok reload (not only a changed one) so
                  // the loop's own `repos`/`graph` bindings — which feed
                  // `selectWorkCandidates` and the scope-starvation notice —
                  // stay in sync too; the unchanged case is just a reference
                  // copy, not a recompute.
                  return { ok: true, revision: loaded.revision || null, repos: factoryRepos, graph: localFactoryGraph };
                }
                return { ok: false, revision: loaded.revision || null, errors: loaded.errors };
              },
              // The final half of the gate verdict (the settled stamp on the
              // run record) and the RESUME SCAN that finds every open pipeline
              // on this box (WORKERS.md §10.8, task-spor-delete-loop-resume-
              // machinery-after-workflow-stages). A gate pipeline is the one
              // piece of work this PROCESS owns, so a worker that dies
              // mid-pipeline leaves a terminal run standing with an un-judged
              // claim, and a pipeline that yields parks its journal and frees
              // its slot — either run is already out of the queue, so no
              // candidate poll would ever return to it. The stage journals and
              // the pipeline lease log beside them (stage-projection.js) are
              // what make it recoverable by any later worker.
              // A verdict is this worker's to stamp only while it still OWNS
              // the pipeline (issue-spor-gate-stamps-bypass-lease-owner): a
              // driver displaced by a takeover (its lease expired while a pass
              // stalled, another worker claimed it) whose own pass then fails
              // must not settle `failed` over the record the new holder is
              // driving. So the check and the stamp are ONE compare-and-swap
              // under the record lock — stampGateState's `own` door, keyed on
              // the lease token this worker's own claim minted (`onClaim`
              // below, escalateParked's `token`). A pipeline settleRunRecord
              // already settled is left as it reads (the builder declines). A
              // run this worker never claimed (its pass threw before the claim,
              // or there was no record to own) may stamp only a record nobody
              // has claimed at all.
              markGate: (runId, patch) => {
                const own = pipelineTokens.get(runId);
                pipelineTokens.delete(runId);
                return stampLoopVerdict(home, runId, patch, own);
              },
              renewGates: (runIds) => {
                for (const runId of runIds || []) {
                  try { dispatchRuns.renewPipeline(home, runId, { workerId }); } catch { /* bounded by the TTL */ }
                }
              },
              runRecord: (runId) => dispatchRuns.readJson(dispatchRuns.runPaths(home, runId).record),
              pendingGates: () => {
                // The cheap half first. On a busy box the run journal is
                // thousands of files (14-day retention) and most are settled or
                // never owed a gate; only a record that still carries an
                // un-judged claim is projected (a readdir of its journal dir).
                const all = dispatchRuns.readRunRecords(home);
                const owed = all.filter((r) => r && r.node_id && dispatchRuns.TERMINAL_STATES.has(r.state) && !(r.gate_state && gatesKernel.SETTLED_GATE_STATES.has(r.gate_state)) && workLoop.shouldGate(r, r));
                const statuses = workLoop.readWorkerStatuses(home, { alive: workerAlive });
                // The bridge from the status-file join this scan replaced: a run
                // a DEAD gate-armed worker's published slots still name was owed
                // a gate even when its record carries no `gate_factory` (it was
                // dispatched by a worker from before the stamp) and no pipeline
                // ever started for it — the one shape the journals cannot
                // witness. A `gating` slot is self-evidencing; an `active` one
                // counts only under a `gates` tally (a bare worker's runs were
                // never owed a gate) — work-loop.js owedByDeadWorkers.
                const owedBy = workLoop.owedByDeadWorkers(statuses);
                const candidatesFor = owed.length ? stageProjection.openPipelineCandidates(home, owed, { owedBy }) : [];
                const ownerLive = (owner) => statuses.some((w) => w.live && w.worker_id === owner);
                const open = workLoop.openPipelines(candidatesFor, {
                  records: all,
                  // Only pipelines THIS factory started, under its current id OR
                  // any id it was renamed from (issue-spor-work-scope-union-
                  // factory-mismatch, issue-spor-factory-rename-strands-
                  // pipelines): resumption never goes through candidate
                  // selection, so without this the repo-scope guard has a back
                  // door straight into another factory's repo.
                  factory: factoryId,
                  factoryAliases: (factory && factory.renamedFrom) || [],
                  onForeign: (slot) =>
                    warn(
                      `work: not resuming the gate pipeline for ${slot.node_id} (run ${String(slot.run_id).slice(0, 8)}) — ` +
                        `it was started under factory '${slot.factory}', not '${factoryId}'${
                          factory && factory.renamedFrom && factory.renamedFrom.length ? ` or any factory it was renamed from (${factory.renamedFrom.join(", ")})` : ""
                        }. Run a worker armed with that factory to finish it.`
                    ),
                  // The run store owns the terminal vocabulary; the scan needs it
                  // to tell a node an agent may still be working from one that is
                  // genuinely idle (a resumed pipeline re-dispatches fix cycles).
                  terminalStates: dispatchRuns.TERMINAL_STATES,
                  maxAgeMs: runMaxMs,
                  ownerLive,
                  liveSlots: workLoop.liveWorkerSlots(statuses),
                  parkedReofferMax,
                });
                // Every open pipeline's node — due or not — stays out of
                // selection while its journal is open.
                openNodes = new Set(candidatesFor.filter((c) => c.projection && c.projection.open && !(c.record.gate_state && gatesKernel.SETTLED_GATE_STATES.has(c.record.gate_state))).map((c) => c.record.node_id));
                return open;
              },
              gate: (entry, record) => {
                pipelineTokens.delete(entry.run_id);
                return runGateAndIntegration(cfg, entry, record, {
                  factory,
                  slug,
                  passthrough,
                  warn,
                  runMaxMs,
                  runIdleMs,
                  home,
                  // Provenance only: which worker on this box pinned the
                  // candidate (task-spor-factory-candidate-record §3.1).
                  workerId,
                  log: (line) => out(line),
                  stopping: () => !!control.stopping,
                  // A plain timer, NOT the loop's wakeable sleep: that one has a
                  // single wake slot the loop owns, and a gate sharing it would
                  // silently cancel the loop's own backoff.
                  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
                  // The lease token this pass claimed, for markGate's `own`.
                  onClaim: (token) => {
                    if (token) pipelineTokens.set(entry.run_id, token);
                  },
                });
              },
              // task-spor-gate-escalation-bounded-auto-retry: the unattended
              // recovery for a refusal whose escalation write failed. Throttled
              // independently of the poll interval (escalationRetryScanMs) — the
              // run journal can hold thousands of records, and most passes have
              // nothing due; this bounds "read the whole journal" to at most
              // once a minute regardless of how tight --interval is set. Each
              // pending retry is bounded on its own backoff (pendingEscalationRetries),
              // so the throttle only guards the directory read, never a retry's
              // own timing.
              retryEscalations: (() => {
                let nextScan = 0;
                return async () => {
                  const at = Date.now();
                  if (at < nextScan) return;
                  nextScan = at + workLoop.WORK_DEFAULTS.escalationRetryScanMs;
                  const pending = workLoop.pendingEscalationRetries(dispatchRuns.readRunRecords(home), { now: Date.now });
                  for (const p of pending) {
                    if (control.stopping) break;
                    await retryOneEscalation(cfg, p, {
                      factory,
                      slug,
                      log: (line) => out(line),
                      warn,
                      home,
                      maxAttempts: escalationRetryMaxAttempts,
                      backoffMs: escalationRetryBackoffMs,
                      maxBackoffMs: escalationRetryMaxBackoffMs,
                    });
                  }
                };
              })(),
              // task-spor-work-loop-parked-reoffer-cap: the loop's escalation
              // door for a pipeline interrupted identically too many times.
              escalateParked: async (args) => {
                pipelineTokens.delete(args.run_id);
                const r = await escalateParkedPipeline(cfg, args, { slug, home, factory: factoryId });
                if (r && r.token) pipelineTokens.set(args.run_id, r.token);
                return r;
              },
              // task-spor-integration-propose-mode: present whenever a factory
              // is armed, but a no-op unless the CURRENT (possibly reloaded)
              // definition's integration mode is 'propose' — read live, at call
              // time, off the same `factory` binding `reloadFactory` swaps, so a
              // pass or serialize edit that turns propose mode ON reaches its
              // own parked items without a restart
              // (task-spor-work-reload-factory-definition-per-pass: gating this
              // on the STARTUP mode instead would strand any proposal a later
              // edit parks, since nothing would ever poll `gh` for it). Every
              // OTHER factory shape still costs only a property check per pass,
              // not a run-journal read — `checkProposals` itself never runs
              // unless something was actually parked. Runs once per pass,
              // outside the slot/concurrency accounting — it never opens a
              // candidate worktree or a run, just reads this box's own run
              // journal and a handful of `gh` calls.
              // ...and, in the same per-pass slot, the controller completion's
              // reconciliation (task-spor-factory-controller-completion-boundary,
              // §6.5 (a)): re-derive and act on every unsettled completion debt
              // on this box — a boundary reached but not written, a premature
              // edge to retype, an item abandoned under a hold. A factory whose
              // completion is the agent's has no controller records, so the
              // journal read finds nothing and the pass is unchanged.
              checkProposals: async () => {
                // ...and the execution-lease HEARTBEAT (task-spor-client-
                // execution-store-adapter): renew every execution this process
                // holds, so a pipeline whose gates run for hours keeps its
                // fence without a timer (a pass is 30s-5min; a lease 15min).
                await renewLiveExecutions((line) => out(line));
                await replayAttestationDebts(cfg, { home, log: (line) => out(line) });
                if (factory.integration && factory.integration.mode === "propose") await checkProposals(cfg, { home, log: (line) => out(line) });
                if (factory.completion && factory.completion.by === "controller") {
                  // ...and the withdrawals an interrupted pass left owed (the
                  // outcome door's debts: an execution ended but its graph hold
                  // not yet cleared, or not yet confirmed ended at all).
                  await reconcileWithdrawnExecutions(cfg, { home, log: (line) => out(line) });
                  await reconcileCompletions(cfg, { home, log: (line) => out(line) });
                }
              },
            }
          : {}),
        sleep: (ms) =>
          new Promise((resolve) => {
            const done = () => {
              control.wake = () => {};
              resolve();
            };
            const t = setTimeout(done, ms);
            control.wake = () => {
              clearTimeout(t);
              done();
            };
          }),
      },
    });
    const o = final.outcomes;
    out(`work: ${final.stop_reason}. dispatched ${final.dispatched}; resolved ${o.resolved}, reported ${o.reported}, failed ${o.failed}${o.unenforced ? ` (${o.unenforced} unenforced)` : ""}.`);
    if (final.gates) {
      out(
        `work: gates — passed ${final.gates.passed}, failed ${final.gates.failed}, blocked ${final.gates.blocked}${
          final.gates.scoped ? `, scoped ${final.gates.scoped}` : ""
        }${final.gates.parked ? `, parked ${final.gates.parked}` : ""}${final.gates.superseded ? `, superseded ${final.gates.superseded}` : ""}${
          final.gates.mismatch ? `, mismatch ${final.gates.mismatch}` : ""
        } (factory ${factoryId}).`
      );
    }
    if (final.active.length) out(`work: ${final.active.length} run(s) still in flight — 'spor runs' follows them to their terminal state.`);
    // A signal-driven stop has to actually END this process. runWorkLoop itself
    // returns promptly on a stop — it never awaits a gate pipeline's own promise
    // (work-loop.js's stop-condition step) — but an ABANDONED pipeline's
    // in-process wait (a fix cycle's or review's awaitGateRun poll, a command
    // gate's suite timer) is a live Node timer this process still holds, and
    // Node does not exit while one is pending: without this, a "stopped" worker
    // would keep running — silently, doing nothing new, but still a live
    // process — for up to that gate's own timeout (a day, for a fix cycle)
    // instead of actually stopping (issue-spor-work-stop-abandons-inflight-
    // gates). The dispatched runs this worker started (including any fix
    // cycle's) are detached OS processes and keep going unaffected by this
    // process exiting — that is the whole point of `gate_fix_run_id` durably
    // naming one (makeGateDeps' `fix`, above): nothing here waits for them, and
    // nothing needs to.
    if (control.stopping) {
      // `out()` writes are fire-and-forget, and process.stdout.write to a pipe
      // is asynchronous — exiting right after queuing the lines above (the
      // abandoned-pipeline notice, the fix-cycle run id) can truncate exactly
      // the diagnostic output this feature exists to produce. This codebase
      // already knows and guards against the same hazard (cmdExport awaits a
      // flush callback before its caller's process.exit, bin/spor.js's `export`
      // handler); a zero-byte write's callback fires only once every
      // already-queued write ahead of it has drained (a Writable stream
      // processes writes strictly in order), so this waits out `out()`'s queue
      // without emitting anything new.
      await new Promise((resolve) => process.stdout.write("", resolve));
      process.exit(0);
    }
    return 0;
    }

    return { candidates, checkAvailability, previewWork, executeWork };
  }

  async function cmdWork(cfg, { values }) {
    if (values.status) return cmdWorkStatus(cfg, { json: !!values.json });
    const plan = await planWork(cfg, { values });
    if (typeof plan === "number") return plan;
    const work = bindWork(cfg, plan);
    // The re-gate verbs are executions of their own and win over --print, as
    // they always did.
    if ((values.print || values["dry-run"]) && !values.regate && !values["regate-flakes"]) return work.previewWork();
    return work.executeWork();
  }

  return { planWork, bindWork, cmdWork };
}

module.exports = { createWorker, stampLoopVerdict, HOST_FUNCTIONS };
