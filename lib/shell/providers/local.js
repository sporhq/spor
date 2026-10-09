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
//            back `{provider: "local", id: <run id>}`; idempotent on the key
//            for this process's lifetime (the handle table is in memory —
//            persisting it on the execution record is
//            task-spor-work-attempt-handle-adoption's).
//   observe  read the record: launching → provisioning, running → running
//            (→ stopping once a graceful cancel was asked), done/failed →
//            finished with the harness exit, failed_launch → failed, vanished
//            → lost; a non-terminal record whose supervisor is demonstrably
//            gone (pid identity, lib/shell/process-identity.js) is `lost` —
//            unless this provider cancelled it, in which case the record is
//            closed here and reads finished.
//   collect  the candidate (the branch's HEAD past the commit the launch
//            started on, referenced through the repo's `origin` URL since a
//            manifest must be fetchable off the environment), the report and
//            the log as file:// references.
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

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const pc = require("../../kernel/provider-contract.js");
const sat = require("../../kernel/satisfiability.js");
const dispatchRuns = require("../agent-dispatch-runner.js");
const processIdentity = require("../process-identity.js");
const candidatePublish = require("../candidate-publish.js");
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

// The idempotency identity of an attempt: everything the worker asked for
// EXCEPT the provider-private launch block, which carries live objects (the
// adapter) and is this provider's own reading of the same request.
function canonicalAttempt(attempt) {
  const { local, ...rest } = attempt || {};
  return JSON.stringify(rest);
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

  function find(handle) {
    const env = handle && envs.get(handle.id);
    if (!env || handle.provider !== PROVIDER_ID) throw new ProviderError("unknown_handle", `no local environment ${JSON.stringify(handle)}`);
    if (env.released) throw new ProviderError("unknown_handle", `local environment ${handle.id} was released`);
    return env;
  }

  const record = (env) => dispatchRuns.readRecord(home, env.runId);

  // Whether the run's supervisor is demonstrably still ours and alive. A
  // record with no pid yet (the launcher stamps it right after the spawn,
  // before submit returns) is read as alive rather than gone.
  function supervisorAlive(rec) {
    const pid = Number.isInteger(rec.runner_pid) && rec.runner_pid > 0 ? rec.runner_pid : null;
    if (pid == null) return true;
    return processIdentity.isOurProcess(pid, rec.runner_started_ticks).reallyAlive;
  }

  function terminalView(rec) {
    const since = rec.finished_at || rec.rev_at || rec.created_at || now();
    const detail = rec.termination_reason || undefined;
    if (rec.state === "vanished") return { state: "lost", since, ...(detail ? { detail } : {}) };
    if (rec.state === "failed_launch") return { state: "failed", since, ...(detail ? { detail } : {}) };
    const exit = {};
    if (Number.isInteger(rec.exit_code)) exit.code = rec.exit_code;
    if (rec.signal) exit.signal = String(rec.signal);
    if (!("code" in exit) && !("signal" in exit)) exit.code = rec.state === "done" ? 0 : 1;
    return { state: "finished", since, exit, ...(detail ? { detail } : {}) };
  }

  // Close a record this provider stopped: the supervisor died on our signal
  // without closing it, so nothing else will.
  function closeCancelled(env, rec, signal) {
    const patch = {
      state: "failed",
      exit_code: null,
      signal,
      finished_at: now(),
      termination_class: "cancelled",
      termination_signal: env.cancel && env.cancel.force ? "provider-force-cancel" : "provider-cancel",
      termination_reason: `the attempt was cancelled through the local provider (${env.cancel && env.cancel.force ? "forced" : "graceful"})`,
    };
    return dispatchRuns.closeRun(dispatchRuns.runPaths(home, env.runId).record, patch, rec.state) || { ...rec, ...patch };
  }

  function observeEnv(env) {
    let rec = record(env);
    if (!rec) return { state: "lost", since: env.acceptedAt, detail: "the run record is gone" };
    if (dispatchRuns.TERMINAL_STATES.has(rec.state)) return terminalView(rec);
    if (!supervisorAlive(rec)) {
      // The closing race: the supervisor closes its record and exits, and a
      // read between the two sees a non-terminal record and a dead pid.
      rec = record(env) || rec;
      if (dispatchRuns.TERMINAL_STATES.has(rec.state)) return terminalView(rec);
      if (env.cancel) return terminalView(closeCancelled(env, rec, env.cancel.force ? "SIGKILL" : "SIGTERM"));
      return { state: "lost", since: now(), detail: "the supervisor process is gone and its record never closed" };
    }
    if (env.cancel) return { state: "stopping", since: env.cancel.at };
    if (rec.state === "launching") return { state: "provisioning", since: rec.created_at || env.acceptedAt };
    return { state: "running", since: rec.started_at || rec.created_at || env.acceptedAt };
  }

  // A worktree launch's candidate: the branch's HEAD once it moved past the
  // commit the launch started on. Referenced through the repo's origin URL —
  // the branch itself is not pushed by this provider (the reference names
  // where a `branch` candidate is fetched from, PROVIDERS.md §7), so a repo
  // with no fetchable origin has no manifest, and says so.
  function collectEnv(env) {
    const rec = record(env);
    const refs = {};
    const report = rec && fileRef(rec.report_path);
    const log = rec && fileRef(rec.log_path);
    if (report) refs.report_ref = report;
    if (log) refs.log_refs = [log];
    const none = (reason) => ({ manifest: null, no_candidate: { reason }, ...refs });
    const head = gitOut(env.launchDir, ["rev-parse", "HEAD"]);
    if (!head) return none(`no commit to collect: ${env.launchDir} is not a git checkout`);
    if (env.baseCommit && head === env.baseCommit) return none(`no candidate: HEAD of ${env.launchDir} is still the launch's base commit ${head.slice(0, 12)}`);
    const a = env.attempt || {};
    if (!a.attempt_id || !a.execution_id || !Number.isInteger(a.fence)) {
      return none(`a candidate exists at ${head.slice(0, 12)} but the attempt carried no execution identity (attempt_id/execution_id/fence) to manifest it under`);
    }
    const tree = gitOut(env.launchDir, ["rev-parse", "HEAD^{tree}"]);
    const branch = gitOut(env.launchDir, ["rev-parse", "--abbrev-ref", "HEAD"]) || (env.worktree && env.worktree.branch) || "HEAD";
    const origin = candidatePublish.resolveRemoteUrl("origin", env.launchDir);
    if (!origin.ok) return none(`a candidate exists at ${head.slice(0, 12)} on ${branch}, but it is held only in ${env.launchDir}: ${origin.reason}`);
    const slug = (Array.isArray(a.repos) && a.repos[0] && a.repos[0].slug) || env.slug;
    return {
      manifest: {
        attempt_id: a.attempt_id,
        execution_id: a.execution_id,
        fence: a.fence,
        candidate: {
          repo: slug,
          commit: head,
          tree,
          branch,
          reference: { kind: "branch", locator: origin.url, ref: `refs/heads/${branch}`, commit: head },
        },
        ...refs,
      },
    };
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
      if (byKey.has(key)) {
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
      const launched = await launchSupervisedHarness(cfg, { ...local.launch, cwd: launchDir });
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
        attempt: { ...attempt, local: undefined },
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

    observe({ handle }) {
      return observeEnv(find(handle));
    },

    collect({ handle }) {
      return collectEnv(find(handle));
    },

    async cancel({ handle, force }) {
      const env = find(handle);
      const rec = record(env);
      if (!rec) return { state: "lost" };
      if (dispatchRuns.TERMINAL_STATES.has(rec.state)) return { state: terminalView(rec).state };
      if (force) {
        env.cancel = { at: now(), force: true };
        await dispatchRuns.stopRun(rec, { graceMs: 0 });
        const closed = record(env) || rec;
        const final = dispatchRuns.TERMINAL_STATES.has(closed.state) ? closed : closeCancelled(env, closed, "SIGKILL");
        return { state: terminalView(final).state };
      }
      if (!env.cancel) env.cancel = { at: now(), force: false };
      // A signal that went out IS the stopping state (the collect window,
      // PROVIDERS.md §8) — answered from the send, not from a fresh observe
      // that could already find the supervisor gone and settle it.
      const sent = signalGraceful(rec);
      return { state: sent ? "stopping" : observeEnv(env).state };
    },

    async release({ handle }) {
      const env = handle && envs.get(handle.id);
      if (!env || handle.provider !== PROVIDER_ID) throw new ProviderError("unknown_handle", `no local environment ${JSON.stringify(handle)}`);
      if (env.released) return { released: true };
      const rec = record(env);
      if (rec && !dispatchRuns.TERMINAL_STATES.has(rec.state)) {
        env.cancel = env.cancel || { at: now(), force: true };
        env.cancel.force = true;
        await dispatchRuns.stopRun(rec, { graceMs: 0 });
        const closed = record(env) || rec;
        if (!dispatchRuns.TERMINAL_STATES.has(closed.state)) closeCancelled(env, closed, "SIGKILL");
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
