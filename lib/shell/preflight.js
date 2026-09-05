"use strict";
// Worker preflight validation (task-spor-worker-preflight-validation).
//
// The Dartlane pilot (art-spor-dartlane-factory-pilot-review-2026-09-05) lost
// two workers to conditions nothing checked before the claim: `fe24cc97`
// launched Claude Code with no unattended posture and every write it tried came
// back permission-blocked, and `4002ba00` put several concurrent writers into
// one shared checkout because the repo declared `dispatch.worktreeSetup` and
// nobody had also set `dispatch.worktree`. Both are cheap to decide BEFORE a
// lease is taken and a child is launched, and both must be decided the SAME way
// for `spor work` and a one-shot `spor dispatch` — per
// dec-spor-work-loop-generalizes-dispatch the loop adds no guards of its own, so
// the guard has to live on the one path both go through (cmdDispatch) and the
// judgement has to live here, where `--print` can ask for it without launching
// anything.
//
// Nothing in this module writes to the graph, mints a credential or spawns a
// child. `acquireWorkspace`/`releaseWorkspace` touch one machine-local lockfile
// under the journal, and that is the only side effect any of it has.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const dispatchHarnesses = require(path.join(__dirname, "dispatch-harnesses.js"));
const dispatchRuns = require(path.join(__dirname, "agent-dispatch-runner.js"));

// --- effective tenant ------------------------------------------------------
// Which graph this dispatch reads and writes, and WHICH selector chose it. The
// second half is the one `spor status` never answered: with an `--org` flag, a
// `SPOR_ORG`, a repo `org:` marker and a store default all able to name a
// tenant (dec-spor-client-cli-mode-tenant-resolution), "which one won" is
// exactly what an operator staring at a worker writing into the wrong graph
// needs. Credentials are NEVER part of this — the token is reported as
// present/missing and never echoed.
const TENANT_SELECTORS = Object.freeze({
  "cli-server": "--server flag",
  "cli-org": "--org flag",
  env: "SPOR_SERVER env",
  "env-org": "SPOR_ORG env",
  "repo-marker": ".spor 'org:' marker",
  "store-default": "credential store default",
  "flat-config": "config.json server+token",
});

function describeTenant(cfg) {
  const mode = cfg.mode();
  if (mode !== "remote") {
    return { mode, org: null, server: null, provenance: "local mode — no tenant", token: false, home: cfg.nodesDir() };
  }
  const t = cfg.tenant();
  const err = typeof cfg.tenantError === "function" ? cfg.tenantError() : null;
  return {
    mode,
    org: (t && t.org) || null,
    server: (t && t.server) || "",
    provenance: err
      ? `${err.kind === "empty-org" ? "--org given an empty value" : `--org '${err.org}' names no stored credential`}`
      : TENANT_SELECTORS[(t && t.source) || ""] || (t && t.source) || "unresolved",
    token: !!(t && t.token),
    error: err ? err.kind : null,
  };
}

function tenantLine(tenant) {
  if (tenant.mode !== "remote") return `local mode (graph ${tenant.home}) — no tenant selector in play`;
  const who = tenant.org ? `${tenant.org} @ ${tenant.server}` : tenant.server || "(unresolved)";
  return `${who}  (via ${tenant.provenance}; token ${tenant.token ? "present" : "MISSING"})`;
}

// --- write posture ---------------------------------------------------------
// A posture is spelled in one harness's flags but says something harness-
// neutral (dispatch-harnesses.js POSTURE_MEANINGS): read-only, attended (it
// stops to ask), unattended (it never asks). Read it from the adapter that OWNS
// the flags, never through the cross-adapter `postureMeaning()`: that one takes
// the most restrictive of EVERY adapter's reading, which is right for
// TRANSLATING a posture into another harness's vocabulary and wrong for judging
// one — a Claude Code launch carrying no permission mode would be read as
// `unattended` off the Codex sandbox/approval defaults that ride every argv.
function launchPostureMeaning(adapter, options) {
  if (!adapter) return null;
  if (typeof adapter.postureMeaning === "function") {
    const m = adapter.postureMeaning(options || {});
    if (m) return m;
  }
  // An adapter that owns no posture flags but DECLARES an empty unattended
  // posture is unattended by construction — OpenCode's `--auto`, Copilot's
  // `--allow-all --no-ask-user`, both baked into the argv builder and, as the
  // adapters say, impossible to unsay.
  if (adapter.unattended && Object.keys(adapter.unattended).length === 0) return "unattended";
  return null;
}

// Whether this client can express a posture for the harness at all. A DECLARED
// custom harness (dispatch.harness.<id>) has none by v1 scope — the operator
// bound the exact argv, so the posture is theirs and every posture flag is
// refused by its own validateOptions. That is "operator-bound", not "unknown":
// there is nothing here to check, only something to say.
function posturePolicy(adapter) {
  if (!adapter) return "none";
  return adapter.unattended == null && adapter.readOnly == null && adapter.attended == null ? "operator-bound" : "declared";
}

// The declared posture rendered as the flags a caller would pass, so a refusal
// names the fix in the operator's own vocabulary instead of a posture word.
// Derived from HARNESS_OPTION_FLAGS, the one membership list, so a new harness
// flag rides along without a second table here.
function posturePhrase(posture) {
  if (!posture) return null;
  const byOption = new Map(Object.entries(dispatchHarnesses.HARNESS_OPTION_FLAGS).map(([flag, spec]) => [spec.option, flag]));
  const parts = [];
  for (const [option, value] of Object.entries(posture)) {
    const flag = byOption.get(option);
    if (flag) parts.push(`--${flag} ${value}`);
  }
  return parts.length ? parts.join(" ") : null;
}

// The posture verdict for ONE launch.
//   `unattended` — this launch has nobody to answer a permission prompt (a
//       `spor work` dispatch, its fix cycles and its rescues). An interactive
//       `spor dispatch` is not judged at all: a person IS the answer, so the
//       attended posture is the supported single-run behavior this must keep.
//   `readOnly`   — the caller asked for a read-only run (a review gate). Writes
//       were never requested, so read-only IS the appropriate posture.
function checkWritePosture({ adapter, options, unattended = false, readOnly = false, harnessId = null }) {
  const policy = posturePolicy(adapter);
  const meaning = readOnly ? "read-only" : launchPostureMeaning(adapter, options);
  const label = (adapter && adapter.label) || harnessId || "the harness";
  const base = { meaning, policy, ok: true, reason: null, hint: null };
  if (!unattended) return base;
  // A read-only run never asked to write, so there is no write posture to
  // judge — and nothing to say about a harness whose argv the operator bound.
  if (readOnly) return base;
  if (policy === "operator-bound") {
    const id = (adapter && adapter.id) || harnessId || "?";
    return {
      ...base,
      warning:
        `warning: this client cannot express a write posture for the declared harness '${id}' — ` +
        `${dispatchHarnesses.declarationKey(id, "args")} IS the posture, and an unattended run that stops to ask has nobody to answer it.`,
    };
  }
  if (meaning === "unattended") return base;
  const want = posturePhrase(adapter && adapter.unattended);
  const reason =
    meaning === null
      ? `no write posture resolved for a ${label} run, so it would stop at the first write with nobody to answer`
      : meaning === "attended"
        ? `the resolved ${label} posture is ATTENDED — it stops to ask before a write, and an unattended run has nobody to answer`
        : `the resolved ${label} posture is ${meaning}, which cannot carry out the writes this run was dispatched to make`;
  return {
    ...base,
    ok: false,
    reason,
    hint: want
      ? `pass ${want} (or route this work to a profile whose harness runs unattended by default); preflight never sets a posture for you.`
      : `route this work to a profile whose harness runs unattended, or give the run a posture it can write under.`,
  };
}

function postureLine(verdict) {
  if (verdict.policy === "operator-bound") return "bound by the harness declaration (this client expresses none)";
  return `${verdict.meaning || "none resolved"}${verdict.ok ? "" : " — an unattended worker would be REFUSED"}`;
}

// Two spellings of one directory are one candidate. `path.resolve` alone
// compares a symlinked `--dir` unequal to the canonical `dispatch.repos` path,
// which would both MISS a concurrent writer and key two different lockfiles for
// one tree. realpath answers the question properly; a path that does not exist
// yet (an isolated worktree not created until launch) has no real path, so fall
// back to resolving its nearest existing ancestor plus the remainder.
function samePathKey(p) {
  // `String(...)`, not a bare `p || ""`: a corrupt run record whose `cwd` is a
  // number passes the caller's truthiness filter and would throw out of a
  // preflight READ, turning a diagnostic into a dispatch failure.
  const abs = path.resolve(String(p || ""));
  try {
    return fs.realpathSync.native(abs);
  } catch {
    /* not created yet (or unreadable) — canonicalize the parent instead */
  }
  const parent = path.dirname(abs);
  if (parent === abs) return abs;
  return path.join(samePathKey(parent), path.basename(abs));
}

// --- candidate workspace ---------------------------------------------------
// Where this launch would actually write, and whether that place is its own.
// `worktreeSetup` is deliberately NOT an input to `useWorktree` — a setup hook
// says how to PREPARE an isolated tree, never that one is wanted — but a repo
// that declares the hook and never turns isolation on is the pilot's second
// failure verbatim, so the plan reports it (`setupOrphaned`) rather than
// quietly honouring one half of the operator's intent.
function planWorkspace({ repoDir, worktreeDir = null, useWorktree = false, worktreeSetup = null, explicitNoWorktree = false }) {
  const dir = useWorktree && worktreeDir ? worktreeDir : repoDir;
  return {
    dir,
    repoDir,
    isolation: useWorktree ? "worktree" : "shared",
    setup: worktreeSetup || null,
    // Declared a setup hook, isolation off, and the operator did not ASK for it
    // off — the hook will never run and the agent writes into the main checkout.
    setupOrphaned: !!worktreeSetup && !useWorktree && !explicitNoWorktree,
  };
}

// A native-background record names no supervisor pid we can probe (`claude
// --bg` hands the child to its own daemon), so it can only be believed for a
// while. The horizon is deliberately SHORT: over-refusing starves a worker that
// has no `--force`, while under-refusing only restores the pre-guard status quo
// for the one launch mode `spor work` never uses
// (issue-spor-dispatch-session-vanished-2026-07-18 is exactly a native record
// nobody ever reconciled to terminal).
const NATIVE_STALE_MS = 3600000;

// The live WRITERS on this box, from the durable run records — the same store
// the same-machine guards already read, so occupancy needs no second registry
// that could disagree with it. Pure over the records so the decision is
// testable without a supervisor.
//   - a supervised record counts while its supervisor is verifiably the one we
//     launched (isSameSupervisor — a hard-killed runner never leaves a false
//     positive, and a recycled pid is not mistaken for it);
//   - a native-background record has no supervisor pid to probe, so where the
//     caller can hand us the harness's own live-agent listing
//     (`nativeAgentEvidence`) it is reconciled EXACTLY against that — a session
//     missing from the listing has ended, whatever the clock says
//     (issue-spor-native-bg-run-record-believed-without-liveness-probe: a
//     finished-but-unreconciled record used to occupy the checkout for the
//     whole 1h horizon regardless). Only when that listing could not be taken
//     (the harness's CLI is absent, or nothing needed it) does it fall back to
//     the short horizon: young enough to still plausibly be running;
//   - a `read_only` run is not a writer and never occupies anything.
function liveWorkspaceWriters(records, {
  dir,
  watching = null,
  now = Date.now,
  staleMs = NATIVE_STALE_MS,
  excludeRunId = null,
  // The caller's `nativeAgentEvidence(cfg, records)` result: the harness's
  // live-agent listing (native-background records only) and whether it could
  // be taken at all. `dispatchRuns.isRunLive` is the SAME identity match
  // `spor runs`/the work loop already reconcile native records against, so
  // occupancy can never disagree with what those surfaces report for the same
  // record.
  nativeAgents = null,
  nativeEnumerated = false,
} = {}) {
  const target = dir ? samePathKey(dir) : null;
  // `supervisorStillWatching`, not a bare `isSameSupervisor`: off Linux (and on
  // an older record) the start-time tick count is unknowable, so liveness
  // collapses to a pid probe that a RECYCLED pid answers just as readily —
  // which here would occupy a shared checkout forever and starve a worker that
  // has no `--force` (issue-spor-dispatch-supervisor-liveness-check-divergence,
  // the divergence class this function must not reintroduce). That helper adds
  // the silence-past-staleMs fallback for exactly the unverifiable case.
  const stillWatching = watching || ((r) => dispatchRuns.supervisorStillWatching(r).watching);
  const out = [];
  for (const r of records || []) {
    if (!r || !r.cwd) continue;
    if (excludeRunId && r.run_id === excludeRunId) continue;
    if (!["launching", "running"].includes(r.state)) continue;
    if (r.read_only) continue;
    if (target && samePathKey(r.cwd) !== target) continue;
    if (r.runner_pid != null) {
      if (!stillWatching(r)) continue;
    } else if (r.launch_mode === "native-background" && nativeEnumerated) {
      if (!dispatchRuns.isRunLive(r, nativeAgents || [])) continue;
    } else {
      const at = Date.parse(r.launched_at || r.started_at || r.created_at || "") || 0;
      if (!at || now() - at > staleMs) continue;
    }
    out.push({ run_id: r.run_id, node_id: r.node_id || null, name: r.name || null, harness: r.harness || null, cwd: r.cwd });
  }
  return out;
}

function describeWriters(writers) {
  return writers
    .map((w) => `${String(w.run_id || "?").slice(0, 8)}${w.node_id ? ` (${w.node_id})` : w.name ? ` (${w.name})` : ""}`)
    .join(", ");
}

// Two writers in one candidate is the condition, whichever side of the
// isolation switch put them there: a shared checkout with isolation off, or a
// worktree a prior dispatch left behind and this one would reuse.
function checkWorkspace({ plan, writers, readOnly = false }) {
  // Symmetric with the record side: a read-only launch (a review gate reading
  // the implementer's checkout) is not a writer, so live writers there are not
  // its problem. Without this the review gate — which passes no `--force` and
  // whose undispatchable verdict gate-runner treats as a FAILURE, never a pass
  // (WORKERS.md §10.4) — would be converted into fix cycles by any unrelated
  // concurrent writer in that checkout.
  if (readOnly) return { ok: true, reason: null, hint: null };
  if (!writers.length) return { ok: true, reason: null, hint: null };
  const where = plan.isolation === "worktree" ? `the worktree ${plan.dir}` : `the shared checkout ${plan.dir}`;
  return {
    ok: false,
    reason: `${where} already has ${writers.length} live writer(s) on this box — ${describeWriters(writers)}`,
    hint:
      plan.isolation === "worktree"
        ? `wait for it, or dispatch under a different name so the run gets its own worktree.`
        : `enable per-dispatch isolation for this repo (dispatch.worktree true in its .spor.json, or pass --worktree)${plan.setup ? ` — it already declares a worktreeSetup hook` : ""}, or wait for the run above to finish.`,
  };
}

// --- atomic workspace acquisition ------------------------------------------
// The check above reads the run records; the record that would make a SECOND
// dispatch see this one is written by the launch. Between the two there is a
// window, and two launchers racing through it both read an empty candidate and
// both land in it. So the check is repeated under an exclusive machine-local
// claim on the candidate path, held from just before the worktree is
// materialized until the run record exists.
//
// The claim is the `u.claimSpoolJob` shape, NOT a well-known lock pathname
// (dec-spor-nudge-drain-atomic-claim's reasoning applies verbatim):
// see-it, judge-it-stale, unlink-it, re-create-it is not a claim — two
// contenders can both break one stale lock and then delete each OTHER's, and a
// racer reading a `wx` file in the window between open and write sees "" and
// judges a LIVE lock unreadable-therefore-stale. Instead each contender creates
// ONLY its own uniquely-named `<key>.lock-<pid>-<ticks>-<ts>-<rand>` and deletes
// ONLY its own; everything a racer must judge is in the NAME, so there is no
// create-then-write window to misread; and ownership is decided by a listing
// taken AFTER the create — you hold the candidate only if no other LIVE
// contender is present, which two contenders can never both conclude (each
// creates before it lists). A lock we cannot take means only "not ours this
// pass", never "act anyway".
//
// A lock whose HOLDER is gone contends with nobody — a dead launcher is not
// launching — so a launcher killed mid-launch self-heals at once rather than
// after a horizon, and its file is reaped once it is also expired (which, since
// every racer already ignores it, can neither grant nor revoke ownership).
// "Gone" is decided by IDENTITY, not by a pid: the name carries the holder's
// kernel start-time tick count, so a RECYCLED pid — which answers a liveness
// probe exactly as readily as the real holder — is provably not our launcher
// and is reaped at once. That matters because the claimed region includes an
// operator's `dispatch.worktreeSetup` hook, which has no bound of its own (an
// `npm ci` plus a container build is normal): a live holder must keep the
// candidate however long that takes, or the guard loses exclusivity in exactly
// the window it exists for. The TTL below is therefore only the fallback for
// the case identity CANNOT be verified — off Linux, where `processStartTicks`
// answers null — and there it is the same trade `supervisorStillWatching`
// already makes: alive alone cannot be trusted forever.
const WORKSPACE_LOCK_STALE_MS = 30 * 60 * 1000;
const WORKSPACE_LOCK_WAIT_MS = 20000;
const WORKSPACE_LOCK_POLL_MS = 250;
// Matched against the part of the name AFTER the `<key>.lock-` prefix:
// `<pid>-<start-ticks|0>-<ts>-<rand>`.
const WORKSPACE_LOCK_STAMP = /^(\d+)-(\d+)-(\d+)-[0-9a-f]+$/;

function workspaceLockDir(home) {
  return path.join(home, "journal", "workspace");
}

function workspaceLockPrefix(dir) {
  const key = crypto.createHash("sha256").update(samePathKey(dir)).digest("hex").slice(0, 16);
  return `${key}.lock-`;
}

// Everything a racer needs to judge one lock is in its NAME. `contends` — its
// holder is still there this pass; `prunable` — it provably is not, so reaping
// the file can neither grant nor revoke ownership (everyone already ignores it).
//
// Deliberately NO "same pid is mine, ignore it" rule (which `claimSpoolJob`
// has): a claim here is per-LAUNCH, not per-process, and one process can hold
// two — `cmdDispatch` is called repeatedly by the work loop. Identity is the
// FILE (the caller skips only its own name), so a lock from this pid that is
// not this token's is a genuine contender.
function workspaceLockContends(name, { now = Date.now, staleMs = WORKSPACE_LOCK_STALE_MS, holder = null } = {}) {
  const m = WORKSPACE_LOCK_STAMP.exec(name);
  if (!m) return { contends: false, prunable: false }; // not one of ours: never touch it
  const pid = Number(m[1]);
  const ticks = Number(m[2]) || null; // 0 == unknowable where it was written (non-Linux)
  const expired = now() - Number(m[3]) >= staleMs;
  const probe = holder || ((p, t) => dispatchRuns.isSameSupervisor(p, t));
  const { reallyAlive, identityKnown } = probe(pid, ticks);
  // A VERIFIED identity is dispositive both ways: the real holder keeps the
  // candidate however long its setup hook runs, and a recycled pid — alive, but
  // demonstrably not our launcher — is reaped at once instead of blocking a
  // worker that has no `--force`.
  if (identityKnown) return { contends: reallyAlive, prunable: !reallyAlive };
  // Unverifiable (off Linux, or the holder is already gone): a bare liveness
  // probe cannot tell our launcher from a recycled pid, so age is the only
  // bound left.
  return { contends: reallyAlive && !expired, prunable: !reallyAlive && expired };
}

// Locks this process holds right now. A THROW between acquisition and launch
// would otherwise strand one naming a still-alive pid — honored for the whole
// stale window, which for a worker with `dispatch.worktree` off is every
// subsequent item refused. `dispatchThroughLocked` sweeps this in its `finally`
// (the one caller that keeps running after a caught throw); a one-shot CLI
// process that dies leaves a lock whose pid is gone, which every racer already
// ignores.
const HELD = new Set();

function attemptWorkspaceClaim(home, dir, opts) {
  const lockDir = workspaceLockDir(home);
  const prefix = workspaceLockPrefix(dir);
  const mine = `${prefix}${process.pid}-${dispatchRuns.processStartTicks(process.pid) || 0}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const file = path.join(lockDir, mine);
  try {
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(file, "", { flag: "wx" });
  } catch (e) {
    // Cannot lock here at all. An unwritable journal must not be the thing that
    // stops a dispatch, so the caller is told it is running WITHOUT the race
    // tiebreak rather than refused — exactly the behavior before this guard
    // existed, and the occupancy check above still ran.
    return { degraded: e.message };
  }
  const token = { file };
  const drop = () => {
    releaseWorkspace(token);
  };
  let entries;
  try {
    entries = fs.readdirSync(lockDir);
  } catch (e) {
    drop();
    return { degraded: e.message }; // cannot tell who else is here: not ours, but not a refusal either
  }
  for (const f of entries) {
    if (f === mine || !f.startsWith(prefix)) continue;
    const { contends, prunable } = workspaceLockContends(f.slice(prefix.length), opts);
    if (contends) {
      drop();
      return { held: f };
    }
    if (prunable) {
      try {
        fs.unlinkSync(path.join(lockDir, f));
      } catch {
        /* a racer may have reaped it already */
      }
    }
  }
  HELD.add(token);
  return { token };
}

// Returns:
//   { ok: true, token }                 — held; release it with releaseWorkspace
//   { ok: true, token: null, degraded } — running without the tiebreak (see above)
//   { ok: false, held }                 — another launcher on this box owns it
async function acquireWorkspace(
  home,
  dir,
  { waitMs = WORKSPACE_LOCK_WAIT_MS, pollMs = WORKSPACE_LOCK_POLL_MS, staleMs = WORKSPACE_LOCK_STALE_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, holder = null } = {}
) {
  const deadline = now() + waitMs;
  for (;;) {
    const r = attemptWorkspaceClaim(home, dir, { now, staleMs, holder });
    if (r.token) return { ok: true, token: r.token };
    if (r.degraded) return { ok: true, token: null, degraded: r.degraded };
    if (now() >= deadline) return { ok: false, held: r.held };
    await sleep(pollMs);
  }
}

// Deletes ONLY this token's own uniquely-named file, so a second or late
// release can never destroy a successor's live claim.
function releaseWorkspace(token) {
  if (!token || !token.file) return;
  HELD.delete(token);
  try {
    fs.rmSync(token.file, { force: true });
  } catch {
    /* it lapses on its own next stale check */
  }
}

// Release everything this process still holds — the leak backstop for a throw
// between acquisition and launch.
function releaseHeldWorkspaces() {
  for (const token of [...HELD]) releaseWorkspace(token);
}

module.exports = {
  TENANT_SELECTORS,
  describeTenant,
  tenantLine,
  launchPostureMeaning,
  posturePolicy,
  posturePhrase,
  checkWritePosture,
  postureLine,
  planWorkspace,
  liveWorkspaceWriters,
  describeWriters,
  checkWorkspace,
  samePathKey,
  workspaceLockDir,
  workspaceLockPrefix,
  workspaceLockContends,
  acquireWorkspace,
  releaseWorkspace,
  releaseHeldWorkspaces,
  WORKSPACE_LOCK_STALE_MS,
  WORKSPACE_LOCK_WAIT_MS,
  NATIVE_STALE_MS,
};
