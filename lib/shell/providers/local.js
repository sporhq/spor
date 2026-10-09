"use strict";
// providers/local.js — the `local` execution provider
// (task-spor-work-local-provider-refactor, constrained-by
// dec-spor-work-execution-provider-contract; PROVIDERS.md §11 "local").
//
// WHERE an attempt runs, for the default case: a git worktree on this box,
// under the detached supervisor `launchSupervisedHarness` starts. This is
// today's `spor dispatch` launch, byte-identical — the same worktree
// creation, the same supervisor spawn, the same run record, job file, prompt
// file and journal paths (test/dispatch-local-provider.test.js pins them
// against a golden recorded from the pre-provider executeDispatch) — moved
// behind the contract's six operations so the loop's one launch door
// (`executeDispatch`) calls a PROVIDER, and a container/VM provider can stand
// in the same place without a second dispatcher.
//
// The split with the layers around it (PROVIDERS.md §1):
//   - the HARNESS ADAPTER layer builds the argv and reads the stream; it is
//     untouched, and executeDispatch still owns it. The provider receives the
//     finished launch inputs on a provider-PRIVATE `attempt.local` block
//     (unknown fields are ignored by the contract, §2) — the repo, the name,
//     whether to isolate, and the exact `launchSupervisedHarness` options —
//     and decides only the environment: the worktree and the cwd.
//   - the SOURCE layer (which item, which factory) is the loop's.
//
// Mapping the contract onto the run record (the one durable thing a local
// launch leaves behind):
//   submit   create the worktree (or reuse it), spawn the supervisor, hand
//            back `{provider: "local", id: <run id>}`; idempotent on the key.
//            An attempt that carries an execution identity (the work loop's
//            attempt driver, lib/shell/provider-attempts.js — the dispatch a
//            person runs carries none and is byte-identical) also stamps its
//            key on the run record's creation write (`provider_attempt`), so
//            the key -> handle table survives this process: a restarted
//            worker's `lookup`/`submit` under the persisted key finds the run
//            it launched, and observe/collect/cancel/release adopt a handle
//            this process never minted (task-spor-work-attempt-handle-
//            adoption).
//   observe  read the record: launching → provisioning, running → running
//            (→ stopping once a graceful cancel was asked), done/failed →
//            finished with the harness exit, failed_launch → failed, vanished
//            → lost; a non-terminal record whose supervisor is demonstrably
//            gone (pid identity, lib/shell/process-identity.js) is `lost` —
//            unless this provider cancelled it, in which case the record is
//            closed here and reads finished.
//   collect  the candidate (the branch's HEAD past the commit the launch
//            started on), PUBLISHED to the repo's `origin` URL and read back
//            before any manifest names it — a manifest must be fetchable off
//            the environment, and a branch nobody pushed is not — plus the
//            report and the log as file:// references.
//   cancel   graceful = SIGTERM to the supervisor's process group (identity-
//            gated, exactly as stopRun gates it); forced = stopRun's TERM-then-
//            KILL with no grace, and the record closed as cancelled.
//   release  stop anything still running, remove the worktree THIS submit
//            created (the existing removeDispatchWorktree, which refuses a
//            dirty tree), forget the handle. Idempotent.
//
// Secrets: none are materialized — the harness runs with the operator's own
// environment — so describe() offers no `secret_delivery` mode and an attempt
// carrying `secrets[]` is refused by the matcher before it is ever submitted
// (dec-spor-attempt-satisfiability-matcher-semantics; the attempt token is
// deliberately not counted, dec-spor-attempt-token-not-capability-secret).

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const pc = require("../../kernel/provider-contract.js");
const sat = require("../../kernel/satisfiability.js");
const dispatchRuns = require("../agent-dispatch-runner.js");
const terminal = require("../dispatch-terminal.js");
const processIdentity = require("../process-identity.js");
const candidatePublish = require("../candidate-publish.js");
// The attempt runner's shared pieces (task-spor-attempt-bundle-run): the one
// launch door (`launchBundle`, the prompt read from the attempt's bundle), the
// record -> observe mapping and the honest collect, so a local attempt and a
// sandboxed `spor attempt run` share one code path.
const attemptLib = require("../attempt.js");
const { bindInProcess, ProviderError } = require("../provider-conformance.js");
const u = require("../../../scripts/engines/util.js");

const PROVIDER_ID = "local";

// The tools the `local` provider's describe() reports when they are on PATH.
// A provider's `tools` axis is "binaries on PATH" (PROVIDERS.md §4.1); PATH
// cannot be enumerated, so local reports this fixed set plus whatever an
// attempt being checked asks for.
const LOCAL_PROVIDER_TOOLS = Object.freeze(["git", "node", "npm", "gh", "docker"]);

// The capability set of the `local` provider (PROVIDERS.md §3), built from
// this machine's effective capability map: a git worktree on this box
// (isolation worktree), the repos `dispatch.repos` maps to a checkout, the
// operator's own network (egress unrestricted) and environment (no secret
// delivery mode), the supervisor's graceful + forced stop, and this box's
// resource ceilings.
function localProviderDescribe(cfg, { tools = [] } = {}) {
  const eff = sat.effectiveCapabilities(cfg.get("dispatch.capabilities", {}) || {});
  const repos = cfg.get("dispatch.repos", {}) || {};
  const wanted = [...new Set([...LOCAL_PROVIDER_TOOLS, ...tools.filter((t) => typeof t === "string" && t)])];
  return {
    provider_id: PROVIDER_ID,
    contract_version: pc.CONTRACT_VERSION,
    capabilities: {
      harnesses: eff.harnesses,
      reachable_mcp: eff.reachable_mcp,
      skills: eff.skills,
      plugins: eff.plugins,
      deny: eff.deny,
      tools: wanted.filter((t) => u.whichSync(t) != null),
      repos: Object.keys(repos && typeof repos === "object" ? repos : {}),
      egress: ["*"],
      isolation: ["worktree"],
      secret_delivery: [],
      lifecycle: ["cancel", "force-cancel"],
      resources: localProviderResources(cfg),
    },
  };
}

// This box's ceilings: its cores, its memory, and the free space on the
// filesystem holding the graph home (where dispatch worktrees' state lands).
function localProviderResources(cfg) {
  const res = { cpu: Math.max(1, os.cpus().length), memory_mb: Math.floor(os.totalmem() / (1024 * 1024)) };
  try {
    const st = fs.statfsSync(cfg.userConfigHome());
    res.disk_mb = Math.floor((st.bavail * st.bsize) / (1024 * 1024));
  } catch {
    /* no statfs here (or the home is not yet created) — declare no disk ceiling */
  }
  return res;
}

// The CLI helpers a local launch needs (the same functions the dispatcher's
// host already carries), named so a missing one fails at construction.
const HOST_FUNCTIONS = Object.freeze(["err", "out", "createDispatchWorktree", "removeDispatchWorktree", "launchSupervisedHarness"]);

const gitOut = (cwd, args) => {
  const s = u.git(cwd, args);
  return s == null ? null : String(s).trim();
};

// The idempotency identity of an attempt: everything the worker asked for,
// the provider-private launch block INCLUDED — it is the only place a local
// attempt names its repo, its worktree and its argv, so leaving it out would
// let a different launch under an accepted key read as a replay. Its one live
// object (the harness adapter) is reduced to the adapter's id, and the rest is
// read as the JSON it round-trips to, so an attempt rebuilt from a persisted
// request is the SAME attempt. Keys are sorted at every level for the same
// reason. The identity is a digest: the launch block carries the run's tokens,
// and the table holding it outlives the submit.
function canonicalAttempt(attempt) {
  const { local, ...rest } = attempt || {};
  const body = { ...rest };
  if (local !== undefined) body.local = launchIdentity(local);
  return crypto.createHash("sha256").update(JSON.stringify(sortKeys(body))).digest("hex");
}
function launchIdentity(local) {
  if (!local || typeof local !== "object") return local;
  const launch = local.launch && typeof local.launch === "object" ? local.launch : null;
  const adapter = launch && launch.adapter;
  const plain = launch ? { ...launch, adapter: adapter && typeof adapter === "object" ? adapter.id || null : adapter } : local.launch;
  return JSON.parse(JSON.stringify({ ...local, launch: plain }) || "null");
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
  return out;
}

function fileRef(p) {
  if (!p) return null;
  try {
    fs.accessSync(p);
  } catch {
    return null;
  }
  return pathToFileURL(p).href;
}

// createLocalProvider({cfg, host}) → the provider: the per-operation `impl`
// (what executeDispatch calls in-process) plus `request`, the contract
// envelope (what the conformance suite drives), plus the test-only
// `environments()` count the suite's driver reads.
function createLocalProvider({ cfg, host, now = () => new Date().toISOString() }) {
  const missing = HOST_FUNCTIONS.filter((k) => typeof (host && host[k]) !== "function");
  if (missing.length) throw new Error(`createLocalProvider: host is missing ${missing.join(", ")}`);
  const { err, out, createDispatchWorktree, removeDispatchWorktree, launchSupervisedHarness } = host;
  const home = cfg.userConfigHome();

  const envs = new Map(); // run id -> environment
  const byKey = new Map(); // idempotency key -> run id

  // Re-read an environment a PREVIOUS process launched (the run record's
  // `provider_attempt` stamp is the persisted half of the key -> handle
  // table). Only a record this provider stamped is adopted — a run some other
  // dispatch launched is not an environment of ours.
  function rehydrate(rec) {
    const pa = rec && rec.provider_attempt;
    if (!pa || pa.provider !== PROVIDER_ID || !pa.idempotency_key) return null;
    if (envs.has(rec.run_id)) return envs.get(rec.run_id);
    const attempt = pa.attempt && typeof pa.attempt === "object" ? pa.attempt : {};
    const env = {
      runId: rec.run_id,
      handle: { provider: PROVIDER_ID, id: rec.run_id },
      key: pa.idempotency_key,
      canon: typeof pa.attempt_digest === "string" && pa.attempt_digest ? pa.attempt_digest : canonicalAttempt(attempt),
      attempt,
      slug: pa.slug || null,
      acceptedAt: pa.accepted_at || rec.created_at || now(),
      launchDir: rec.cwd,
      baseCommit: pa.base_commit || null,
      worktree: pa.worktree || null,
      view: {
        run_id: rec.run_id,
        state: rec.state || null,
        session_id: rec.session_id || null,
        paths: { record: dispatchRuns.runPaths(home, rec.run_id).record, log: rec.log_path, report: rec.report_path },
        cwd: rec.cwd,
        worktree: pa.worktree ? { dir: pa.worktree.dir, branch: pa.worktree.branch, created: !!pa.worktree.created } : null,
      },
      cancel: null,
      released: false,
      adopted: true,
    };
    envs.set(rec.run_id, env);
    byKey.set(env.key, rec.run_id);
    return env;
  }

  function adoptByHandle(handle) {
    if (!handle || handle.provider !== PROVIDER_ID || envs.has(handle.id)) return;
    rehydrate(dispatchRuns.readRecord(home, handle.id));
  }

  function adoptByKey(key) {
    if (!key || byKey.has(key)) return;
    const rec = dispatchRuns.readRunRecords(home).find((r) => r && r.provider_attempt && r.provider_attempt.idempotency_key === key);
    if (rec) rehydrate(rec);
  }

  function find(handle) {
    adoptByHandle(handle);
    const env = handle && envs.get(handle.id);
    if (!env || handle.provider !== PROVIDER_ID) throw new ProviderError("unknown_handle", `no local environment ${JSON.stringify(handle)}`);
    if (env.released) throw new ProviderError("unknown_handle", `local environment ${handle.id} was released`);
    return env;
  }

  const record = (env) => dispatchRuns.readRecord(home, env.runId);

  const supervisorAlive = attemptLib.supervisorAlive;
  const terminalView = (rec) => attemptLib.terminalView(rec, now());

  // Close a record this provider stopped: the supervisor died on our signal
  // without closing it, so nothing else will. The patch carries what every
  // other terminal writer stamps (launchFailure, finalizeIdleRun): the process
  // dimension (how it ended) AND the outcome dimension — unenforced, since
  // nothing verified the target against the graph — so the loop's and `spor
  // runs`' status readers see a stopped run, not a record with no verdict.
  function closeCancelled(env, rec, signal, stopped = null) {
    const forced = !!(env.cancel && env.cancel.force);
    const patch = {
      state: "failed",
      exit_code: null,
      signal,
      finished_at: now(),
      termination_class: "cancelled",
      termination_signal: forced ? "provider-force-cancel" : "provider-cancel",
      termination_reason: `the attempt was cancelled through the local provider (${forced ? "forced" : "graceful"})`,
      ...(stopped && stopped.child ? { child_reaped: true } : {}),
      ...terminal.unenforcedOutcome("failed", "the attempt was cancelled through the local provider; nothing was verified against the graph"),
    };
    return dispatchRuns.closeRun(dispatchRuns.runPaths(home, env.runId).record, patch, rec.state) || { ...rec, ...patch };
  }

  // Close a record whose supervisor is GONE and which nobody cancelled (the
  // `lost` reading), on release: the run crashed and was then torn down,
  // which is a vanish, never a cancel — filing it as one would misread every
  // crashed run this provider releases.
  function closeVanished(env, rec, stopped = null) {
    const patch = {
      state: "vanished",
      finished_at: now(),
      termination_class: "vanished",
      termination_signal: "supervisor-gone",
      termination_reason: "the supervisor process is gone and its record never closed; the local provider released the environment",
      ...(stopped && stopped.child ? { child_reaped: true } : {}),
      ...terminal.unenforcedOutcome("vanished", "the run's supervisor vanished before any outcome was recorded; nothing was verified against the graph"),
    };
    return dispatchRuns.closeRun(dispatchRuns.runPaths(home, env.runId).record, patch, rec.state) || { ...rec, ...patch };
  }

  async function observeEnv(env) {
    let rec = record(env);
    if (!rec) return { state: "lost", since: env.acceptedAt, detail: "the run record is gone" };
    if (dispatchRuns.TERMINAL_STATES.has(rec.state)) return terminalView(rec);
    if (!supervisorAlive(rec)) {
      // The closing race: the supervisor closes its record and exits, and a
      // read between the two sees a non-terminal record and a dead pid.
      rec = record(env) || rec;
      if (dispatchRuns.TERMINAL_STATES.has(rec.state)) return terminalView(rec);
      if (env.cancel) {
        // The supervisor died on our signal without closing its record. What
        // it left behind — a harness child the group signal did not reach
        // where the group was not provably ours — is reaped the way stopRun
        // reaps it (identity-checked), and the record closed as the cancel
        // it was, carrying that reap.
        const stopped = await dispatchRuns.stopRun(rec, { graceMs: 0 });
        rec = record(env) || rec;
        if (dispatchRuns.TERMINAL_STATES.has(rec.state)) return terminalView(rec);
        return terminalView(closeCancelled(env, rec, env.cancel.force ? "SIGKILL" : "SIGTERM", stopped));
      }
      return { state: "lost", since: now(), detail: "the supervisor process is gone and its record never closed" };
    }
    return attemptLib.observeRecord(rec, { alive: true, cancelAt: env.cancel ? env.cancel.at : null, acceptedAt: env.acceptedAt, now: now() });
  }

  // A worktree launch's candidate: the branch's HEAD once it moved past the
  // commit the launch started on, PUBLISHED to the repo's origin and read
  // back (attemptLib.collectCandidate, the same collect `spor attempt run`
  // makes) — a repo with no fetchable origin, or a push that does not land,
  // has no manifest, and says so.
  function collectEnv(env) {
    const rec = record(env);
    const refs = {};
    const report = rec && fileRef(rec.report_path);
    const log = rec && fileRef(rec.log_path);
    if (report) refs.report_ref = report;
    if (log) refs.log_refs = [log];
    const a = env.attempt || {};
    // The CONFIGURED url, not this box's insteadOf rewrite of it: the locator
    // is for a reader elsewhere. A url that cannot be proven credential-free
    // is withheld (no locator, so no manifest), never passed through.
    const origin = candidatePublish.resolveRemoteUrl("origin", env.launchDir, { raw: true });
    const locator = origin.ok ? pc.stripReferenceUserinfo(origin.url) : null;
    // Why there is none: a url with nowhere for a credential to hide (no `@`,
    // no whitespace) — a filesystem path — is simply not portable, and says
    // so; anything else is withheld without being quoted.
    const withheld = !origin.ok ? origin.reason
      : locator ? null
      : !/[@\s]/.test(origin.url) ? `the git remote 'origin' resolves to ${candidatePublish.portableRemoteRefusal(origin.url) || `'${origin.url}', which is not a reference`}`
      : "the repo's origin url cannot be proven free of credentials, so it is withheld rather than named in a manifest";
    return attemptLib.collectCandidate({
      cwd: env.launchDir,
      baseCommit: env.baseCommit,
      attempt: a,
      slug: (Array.isArray(a.repos) && a.repos[0] && a.repos[0].slug) || env.slug,
      branch: gitOut(env.launchDir, ["rev-parse", "--abbrev-ref", "HEAD"]) || (env.worktree && env.worktree.branch) || null,
      // A credential embedded in the origin URL never reaches a manifest.
      locator,
      // Published where git would push `origin` (its pushurl, when one is set)
      // and read back from there; named by the fetch URL a reader uses. That
      // naming is the MIRROR ASSUMPTION: a pushurl that differs from the fetch
      // url is taken to feed it (a push mirror, a fork's upstream), and the
      // read-back proves the push landed, not that the fetch url serves it yet.
      transport: origin.ok ? gitOut(env.launchDir, ["remote", "get-url", "--push", "origin"]) || origin.url : null,
      locatorReason: withheld,
      refs,
    });
  }

  // A graceful stop is a REQUEST: SIGTERM to the supervisor's group, gated on
  // the same proven identity stopRun gates its group arm on, and nothing more.
  function signalGraceful(rec) {
    const pid = Number.isInteger(rec.runner_pid) && rec.runner_pid > 0 ? rec.runner_pid : null;
    if (pid == null) return false;
    const identity = processIdentity.isOurProcess(pid, rec.runner_started_ticks);
    if (!identity.reallyAlive) return false;
    let sent = false;
    if (identity.identityKnown) {
      try {
        process.kill(-pid, "SIGTERM");
        sent = true;
      } catch {
        /* no process groups here, or already gone */
      }
    }
    try {
      process.kill(pid, "SIGTERM");
      sent = true;
    } catch {
      /* already gone */
    }
    return sent;
  }

  const impl = {
    describe() {
      return localProviderDescribe(cfg);
    },

    async submit({ attempt, idempotency_key: key }) {
      const local = attempt && attempt.local;
      if (!local || typeof local !== "object" || !local.launch || typeof local.launch !== "object") {
        throw new ProviderError("invalid_request", "the local provider runs only a launch it was handed: attempt.local {repoDir, name, useWorktree, launch} is required");
      }
      const canon = canonicalAttempt(attempt);
      adoptByKey(key);
      if (byKey.has(key)) {
        // Same key, same attempt: the SAME handle, released or not (§6 promises
        // the handle, and a released one answers unknown_handle on every later
        // op — a replay never mints a second environment under an accepted key).
        const env = envs.get(byKey.get(key));
        if (env.canon !== canon) throw new ProviderError("idempotency_conflict", `key ${key} was accepted for a different attempt`);
        return { handle: env.handle, accepted_at: env.acceptedAt, existing: true, env: env.view };
      }
      const repoDir = String(local.repoDir || "");
      const name = String(local.name || "");
      // Materialize the worktree just before launch — AFTER every guard/claim
      // the dispatcher ran, so a refused dispatch never leaves a worktree
      // behind — and run the agent inside it. repoDir stays the registered
      // slug->path target (the durable main checkout, issue-spor-dispatch-
      // worktree-dir-stamping); only the launch cwd moves.
      let launchDir = repoDir;
      let worktree = null;
      if (local.useWorktree) {
        const wt = createDispatchWorktree(repoDir, name, { slug: local.slug || null, nodeId: local.nodeId || null });
        if (wt.error) {
          err(`could not create dispatch worktree under ${repoDir}: ${wt.error}`);
          err(`  (is ${repoDir} a git repo with at least one commit? or pass --no-worktree.)`);
          throw new ProviderError("unavailable", `could not create dispatch worktree under ${repoDir}: ${wt.error}`);
        }
        if (wt.setupError) {
          err(`dispatch worktree setup hook failed: ${wt.setupError}`);
          if (wt.created) {
            const rm = removeDispatchWorktree(repoDir, wt.dir, wt.branch);
            if (rm.removed) {
              err(`  removed the half-prepped worktree ${wt.dir}. Fix dispatch.worktreeSetup or pass --no-worktree.`);
            } else {
              err(`  could not remove the half-prepped worktree ${wt.dir}: ${rm.reason}`);
              err(`  clean it up manually, then fix dispatch.worktreeSetup or pass --no-worktree.`);
            }
          } else {
            err(`  left the reused worktree ${wt.dir} in place. Fix dispatch.worktreeSetup or pass --no-worktree.`);
          }
          throw new ProviderError("unavailable", `dispatch worktree setup hook failed: ${wt.setupError}`);
        }
        launchDir = wt.dir;
        worktree = { repoDir, dir: wt.dir, branch: wt.branch, created: !wt.reused };
        out(`worktree: ${wt.dir} (branch ${wt.branch}${wt.reused ? ", reused" : ""}${wt.setupRan ? "; setup ran" : ""})`);
      }
      const baseCommit = gitOut(launchDir, ["rev-parse", "HEAD"]);
      // The persisted half of the key -> handle table, on the run record's
      // CREATION write — only for an attempt the work loop's attempt driver
      // submits (it carries an execution identity), so a person's own
      // dispatch keeps its record byte-identical.
      const publicAttempt = { ...attempt, local: undefined };
      delete publicAttempt.local;
      const stamp = attempt.execution_id
        ? {
            provider_attempt: {
              provider: PROVIDER_ID,
              idempotency_key: key,
              attempt: publicAttempt,
              attempt_digest: canon,
              slug: local.slug || null,
              base_commit: baseCommit || null,
              worktree,
            },
          }
        : null;
      const launch = stamp ? { ...local.launch, recordFields: { ...(local.launch.recordFields || {}), ...stamp } } : local.launch;
            // The one launch door: the dispatch's launch, its prompt read from the
      // attempt's (in-memory) bundle — the bytes are the dispatcher's own.
      const launched = await attemptLib.launchBundle(cfg, attemptLib.bundleFromLaunch(attempt, local.launch), {
        cwd: launchDir, launch, launchSupervisedHarness,
      });
      if (!launched.ok) {
        err(`could not launch ${local.launch.command}: ${launched.error}`);
        throw new ProviderError("unavailable", `could not launch ${local.launch.command}: ${launched.error}`);
      }
      const acceptedAt = now();
      const view = {
        run_id: launched.runId,
        state: (launched.state && launched.state.state) || null,
        session_id: (launched.state && launched.state.session_id) || null,
        paths: { record: launched.paths.record, log: launched.paths.log, report: launched.paths.report },
        cwd: launchDir,
        worktree: worktree ? { dir: worktree.dir, branch: worktree.branch, created: worktree.created } : null,
      };
      const env = {
        runId: launched.runId,
        handle: { provider: PROVIDER_ID, id: launched.runId },
        key,
        canon,
        attempt: publicAttempt,
        slug: local.slug || null,
        acceptedAt,
        launchDir,
        baseCommit,
        worktree,
        view,
        cancel: null,
        released: false,
      };
      envs.set(launched.runId, env);
      byKey.set(key, launched.runId);
      return { handle: env.handle, accepted_at: acceptedAt, existing: false, env: view };
    },

    async observe({ handle }) {
      return observeEnv(find(handle));
    },

    // Outside the six contract operations, in-process only: what was accepted
    // under `idempotency_key`, by this process or (through the run record's
    // stamp) an earlier one — the submit result a re-send would answer, or
    // null. The attempt driver consults it before re-sending a held submit,
    // so a restarted worker reconciles without being handed the launch again.
    lookup({ idempotency_key: key }) {
      adoptByKey(key);
      const env = byKey.has(key) ? envs.get(byKey.get(key)) : null;
      return env ? { handle: env.handle, accepted_at: env.acceptedAt, existing: true, env: env.view } : null;
    },

    collect({ handle }) {
      return collectEnv(find(handle));
    },

    async cancel({ handle, force }) {
      const env = find(handle);
      const rec = record(env);
      if (!rec) return { state: "lost" };
      if (dispatchRuns.TERMINAL_STATES.has(rec.state)) return { state: terminalView(rec).state };
      // A run whose supervisor is already gone and that nobody cancelled is
      // LOST, through this door as through release: a force here tears down
      // what the crash left and files a vanish, never a cancel.
      const wasLost = !env.cancel && !supervisorAlive(rec);
      if (force) {
        if (!wasLost) env.cancel = { at: now(), force: true };
        const stopped = await dispatchRuns.stopRun(rec, { graceMs: 0 });
        const closed = record(env) || rec;
        const final = dispatchRuns.TERMINAL_STATES.has(closed.state)
          ? closed
          : wasLost ? closeVanished(env, closed, stopped) : closeCancelled(env, closed, "SIGKILL", stopped);
        return { state: terminalView(final).state };
      }
      if (wasLost) return { state: (await observeEnv(env)).state };
      if (!env.cancel) env.cancel = { at: now(), force: false };
      // A signal that went out IS the stopping state (the collect window,
      // PROVIDERS.md §8) — answered from the send, not from a fresh observe
      // that could already find the supervisor gone and settle it.
      const sent = signalGraceful(rec);
      return { state: sent ? "stopping" : (await observeEnv(env)).state };
    },

    async release({ handle }) {
      adoptByHandle(handle);
      const env = handle && envs.get(handle.id);
      if (!env || handle.provider !== PROVIDER_ID) throw new ProviderError("unknown_handle", `no local environment ${JSON.stringify(handle)}`);
      if (env.released) return { released: true };
      const rec = record(env);
      if (rec) {
        // A run still being supervised (or one a cancel already asked to stop)
        // is stopped and closed as cancelled; one whose supervisor is already
        // gone was never cancelled — it is lost, and its teardown reaps what
        // the crash left. A record already closed is not rewritten, but what
        // stopRun can prove is ours (a harness child a close never reaped) is
        // still signalled, so nothing of this environment outlives release.
        const terminal = dispatchRuns.TERMINAL_STATES.has(rec.state);
        const wasLost = !terminal && !env.cancel && !supervisorAlive(rec);
        if (!terminal && !wasLost) {
          env.cancel = env.cancel || { at: now(), force: true };
          env.cancel.force = true;
        }
        const stopped = await dispatchRuns.stopRun(rec, { graceMs: 0 });
        if (!terminal) {
          const closed = record(env) || rec;
          if (!dispatchRuns.TERMINAL_STATES.has(closed.state)) {
            if (wasLost) closeVanished(env, closed, stopped);
            else closeCancelled(env, closed, "SIGKILL", stopped);
          }
        }
      }
      let worktree = null;
      if (env.worktree && env.worktree.created) {
        const rm = removeDispatchWorktree(env.worktree.repoDir, env.worktree.dir, env.worktree.branch);
        worktree = rm.removed ? { removed: true } : { removed: false, reason: rm.reason };
      }
      env.released = true;
      return { released: true, ...(worktree ? { worktree } : {}) };
    },
  };

  return {
    id: PROVIDER_ID,
    impl,
    request: bindInProcess(impl).request,
    // Test-only, outside the contract: how many environments this provider
    // still holds (the conformance driver's `environments()`), and the run
    // id behind a handle (its `crash()` reads the record to find the pid).
    environments: () => [...envs.values()].filter((e) => !e.released).length,
    runIdOf: (handle) => (handle && envs.has(handle.id) ? envs.get(handle.id).runId : null),
  };
}

module.exports = { PROVIDER_ID, LOCAL_PROVIDER_TOOLS, HOST_FUNCTIONS, localProviderDescribe, localProviderResources, createLocalProvider, canonicalAttempt };
