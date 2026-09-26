"use strict";
// spool-sweeper — the cross-session door onto STRANDED async capture-nudge
// spools (task-spor-nudge-async-cross-session-spool-sweep).
//
// The async capture nudge parks a classifier-verified finding as
// journal/pending-nudges/<session>/<hash>.out.json and gives it two drains: the
// owning session's next UserPromptSubmit (prompt-context.js drainPendingNudges)
// and, for a finding produced by that session's FINAL action, its own SessionEnd
// (distill.js sessionEndPendingNudges). Both are anchored on the OWNING session
// still doing something. A dispatched/background agent session can end without
// either — the 2026-09-04 replay (art-spor-async-nudge-loss-remeasured-2026-09-04)
// could not rule out up to 5 of 69 classified facts lost that way, and 3 of its 4
// indeterminate findings were `.claude/worktrees` dispatch sessions. distill.js's
// collector widens who comes back for such a spool, but it too runs only from some
// OTHER session's SessionEnd: on a box whose sessions are all dispatched agents
// that never fire one, nothing collects at all.
//
// This is the door that depends on no session ending. SessionStart spawns it
// DETACHED (session-start.js), so a capture round trip never rides a hook's
// latency budget, and it recovers a spool only where a durable record PROVES the
// owning session is over (dec-spor-stranded-spool-terminal-evidence-policy):
//
//   • EVIDENCE, not age. The only terminal evidence this reads is a dispatch RUN
//     RECORD (journal/dispatch/*.run.json) that BOUND the spool's session id and
//     is in a terminal state — the durable completion record the dispatch
//     contract already writes, and exactly the population the loss concentrated
//     in. A session with no such record is AMBIGUOUS (it may be an interactive
//     session idling between prompts, whose own next prompt is the better home
//     for the finding) and is left untouched and REPORTED. distill.js's 6h
//     age-based collector is unchanged and still the last resort before journal
//     GC for those.
//   • ATTRIBUTION, never substitution. A recovered finding is captured under the
//     ORIGIN session's context: keyed on that session (so its idempotency key and
//     node id are the ones its own drain would have minted, via
//     drainPendingNudgeSpool's `foreign` arm), stamped to the project of the FILE
//     it was classified from with the ORIGIN session's own slug as the fallback —
//     the sweeping session's slug is never used — and recovered only when the
//     origin's TENANT is the tenant this sweep resolves. That provenance is read
//     from an `origin.json` post-tool writes beside the spool; a spool without one
//     (written before this shipped, or whose write failed) is retained and
//     reported, never guessed at.
//   • NO NEW DEBT. The `.out.json` remains the whole debt and every consume rule
//     stays distill.js's: this only widens who comes back for one. `origin.json`
//     is inert descriptive metadata — its absence makes a spool LESS eligible,
//     never more — so a failed write costs nothing that has to be reconciled
//     later. Concurrency with either existing drain is the atomic per-result
//     claim they already share (dec-spor-nudge-drain-atomic-claim).
//
// Gated on nudge.async (and nudge.enabled) like every other async-path syscall:
// with the shipped synchronous default nothing here runs, no spool exists to
// find, and session-start never even loads this module.
//
//   node spool-sweeper.js <cwd> <sweeping-session-id>

const fs = require("fs");
const path = require("path");
const u = require("./util");

const ORIGIN_FILE = "origin.json";

// Bounds. Generous next to the SessionEnd collector's (20s / 10 results), since
// this runs detached with no hook budget over it, but bounded all the same: each
// result is its own capture round trip, and a hung server must not leave a
// process cycling for an hour. Stopping early has no durable consequence — an
// unreached result is left byte-for-byte as found and the next SessionStart on
// this box is what comes back for it.
const SWEEP_BUDGET_MS = 120000;
const SWEEP_RESULT_MAX = 25;
const SWEEP_DIR_MAX = 10;
// The candidate scan is a hook-path read (session-start decides whether to spawn
// at all), so it is bounded too: a box with more stranded spools than this has
// plenty for one pass to work on.
const SCAN_DIR_MAX = 200;
// How often a box sweeps at all (nudge.sweepIntervalMs / SPOR_NUDGE_SWEEP_INTERVAL).
// A spool that is retained rather than recovered — an ambiguous session, another
// tenant's, a legacy one — stays exactly where it is until journal GC, and
// without a throttle every SessionStart on a fleet box would re-spawn a sweeper
// and re-log the same tally for it. Recovery is not urgent (a stranded finding
// has already outlived its session), so half an hour of granularity costs
// nothing. The stamp is NOT a debt flag: it only ever DELAYS a pass, the
// `.out.json` is still the whole debt, and a failed stamp write falls through to
// sweeping — the safe side is doing the work, not skipping it.
const SWEEP_INTERVAL_MS = 1800000;
const SWEEP_STAMP = "spool-swept";

// --- origin metadata --------------------------------------------------------

// Persist who a spool belongs to, written by post-tool.js when it creates the
// dir. First write wins (`wx`): the record describes the SESSION's identity —
// its tenant and its home project — not the individual finding, whose own
// project is read from the classified file's location at capture time.
// Best-effort by construction: a spool with no origin is simply not eligible for
// this sweep, so a failed write can only withhold recovery, never misdirect it.
function writeSpoolOrigin(dir, { session, slug, cwd, server, org }) {
  try {
    fs.writeFileSync(
      path.join(dir, ORIGIN_FILE),
      JSON.stringify({ session, slug: slug || "", cwd: cwd || "", server: server || "", org: org || "", ts: u.jqNow() }),
      { flag: "wx" }
    );
    return true;
  } catch {
    return false; // already there (the common case), or unwritable
  }
}

function readSpoolOrigin(dir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dir, ORIGIN_FILE), "utf8"));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

// The tenant a capture would land in from HERE — the same pair origin.json
// records: the resolved server base ("" in local mode, where the graph home is
// itself the tenant boundary) and the active org.
function currentTenant() {
  let org = "";
  try {
    org = u.config()?.tenant?.()?.org || "";
  } catch {
    /* no active config / no credential store: local, or a flat server+token */
  }
  return { server: u.serverBase(), org };
}

// --- terminal evidence ------------------------------------------------------

// session id -> { terminal, state } over the durable dispatch run records. A
// record binding a session in a terminal state is the completion record the
// dispatch contract already writes; anything else binding it says the run is
// still live, which is the conservative reading when a session has both (an id
// bound by two records is not something to guess about).
//
// TERMINAL_STATES is imported rather than restated so this cannot drift from the
// vocabulary the runner writes. Read once per sweep — the records are a flat dir
// and each spool would otherwise re-scan it.
//
// The records live under the PERSONAL user-config home, which is where every
// launcher writes them; the spools live under the GRAPH home, and a repo `.spor`
// `graph:` binding makes those two different directories. Reading evidence from
// the wrong one would find no record for any session and quietly sweep nothing.
function terminalSessions(recordsHome = u.userConfigHome()) {
  const bound = new Map();
  let TERMINAL_STATES;
  let readRunRecords;
  try {
    ({ TERMINAL_STATES, readRunRecords } = require("../../lib/shell/agent-dispatch-runner.js"));
  } catch {
    return bound; // no runner module reachable: no evidence, so nothing is swept
  }
  let records = [];
  try {
    records = readRunRecords(recordsHome);
  } catch {
    return bound;
  }
  for (const r of records) {
    if (!r || !r.session_id) continue; // an unbound record attributes to no session
    const terminal = TERMINAL_STATES.has(r.state);
    const prev = bound.get(r.session_id);
    if (prev && !prev.terminal) continue; // a live record wins over a terminal one
    bound.set(r.session_id, { terminal, state: r.state });
  }
  return bound;
}

// --- the sweep --------------------------------------------------------------

function outResults(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".out.json"));
  } catch {
    return [];
  }
}

// Does this home hold a spool that is not the running session's own and still
// carries a result? The cheap precheck session-start runs before paying for a
// spawn: a readdir of the spool root plus one readdir per dir, stopping at the
// first hit. Says nothing about ELIGIBILITY — the sweep re-decides that on the
// evidence — only that there is something worth looking at. Consumed spool
// dirs are deliberately left behind empty (no rmdir — see prompt-context.js),
// so a box can accumulate far more non-self dirs than SCAN_DIR_MAX without any
// of them holding a result; hitting the cap is therefore INCONCLUSIVE, never a
// clean no, so it spawns the real sweep the same as a hit would (the safe side
// is doing the work, like the unreadable-stamp case above).
function hasSweepCandidates(graph, session) {
  let subs;
  try {
    subs = fs.readdirSync(path.join(graph, "journal", "pending-nudges"), { withFileTypes: true });
  } catch {
    return false;
  }
  let scanned = 0;
  for (const s of subs) {
    if (!s.isDirectory() || s.name === session) continue;
    if (++scanned > SCAN_DIR_MAX) return true;
    if (outResults(path.join(graph, "journal", "pending-nudges", s.name)).length) return true;
  }
  return false;
}

// The whole spawn decision session-start makes: is the box due a pass, and is
// there anything to look at? Stamped BEFORE the spawn, like the fleet
// heartbeat's cooldown — a sweeper that dies (or a box where spawning cannot
// work at all) must not make every SessionStart pay for it again. Reading the
// stamp costs one stat; the candidate scan runs only once a pass is due.
function shouldSweep(graph, session, { now = Date.now(), intervalMs = null } = {}) {
  const every = intervalMs == null ? u.cfgNum("nudge.sweepIntervalMs", "NUDGE_SWEEP_INTERVAL", SWEEP_INTERVAL_MS) : intervalMs;
  const stamp = path.join(graph, "journal", SWEEP_STAMP);
  if (every > 0) {
    try {
      const last = Number(fs.readFileSync(stamp, "utf8").trim());
      if (Number.isFinite(last) && now - last < every) return false;
    } catch {
      /* no stamp yet, or unreadable: sweep */
    }
  }
  if (!hasSweepCandidates(graph, session)) return false;
  try {
    fs.writeFileSync(stamp, `${now}\n`);
  } catch {
    /* an unwritable stamp costs an extra pass, never a missed one */
  }
  return true;
}

// The disposition of every non-own spool dir that still holds a result. Pure
// (read-only) so both the sweep and any operator surface can report the same
// counts from the same rules — retention has to be as visible as recovery or it
// reads as success (the dispatch contract's "expose skipped/ambiguous counts").
//   recover      — a run record proves the owning session ended, and the origin
//                  is this tenant's
//   live         — a run record binds the session and is NOT terminal
//   unknown      — no record binds it: idle or gone, indistinguishable here
//   other_tenant — the origin names a different server/org than this sweep
//                  resolves; recovering it would file the finding in the wrong
//                  graph under the wrong identity
//   unattributed — no origin.json (a legacy spool, or a failed write): its scope
//                  cannot be established, so it is retained and reported
function classifySpools(graph, session, opts = {}) {
  const base = path.join(graph, "journal", "pending-nudges");
  let subs;
  try {
    subs = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const s of subs) {
    if (!s.isDirectory() || s.name === session) continue;
    const dir = path.join(base, s.name);
    const results = outResults(dir);
    if (!results.length) continue; // nothing owed here
    let mtime = 0;
    try {
      mtime = fs.statSync(dir).mtimeMs;
    } catch {}
    out.push({ session: s.name, dir, results: results.length, mtime, origin: readSpoolOrigin(dir) });
  }
  // Reading every run record is the most expensive thing here, so it happens
  // only once there is something to judge — a pass with no spool at all (the
  // ordinary case) costs the readdir and nothing else.
  if (!out.length) return out;
  const tenant = opts.tenant || currentTenant();
  const evidence = opts.evidence || terminalSessions();
  for (const e of out) {
    e.evidence = evidence.get(e.session) || null;
    if (!e.origin || !e.origin.slug) e.disposition = "unattributed";
    else if ((e.origin.server || "") !== tenant.server || (e.origin.org || "") !== tenant.org) e.disposition = "other_tenant";
    else if (!e.evidence) e.disposition = "unknown";
    else if (!e.evidence.terminal) e.disposition = "live";
    else e.disposition = "recover";
  }
  // Oldest first: closest to the journal GC cutoff, so the most endangered
  // spool is served before a bound stops the pass.
  out.sort((a, b) => a.mtime - b.mtime);
  return out;
}

// Recover the eligible spools, reporting what was left behind and why. Returns
// the tally; never throws (a sweep failing is a sweep that did not happen, and
// the debt it did not discharge is still sitting in the spool for the next one).
async function sweepStrandedSpools({ graph, session, remote, budget = null }) {
  // Required HERE, not at module load: session-start's precheck loads this file
  // on every async-mode SessionStart and must not pay for the distiller's own
  // module graph when there is nothing to sweep.
  const { drainPendingNudgeSpool: drain, makeSpoolBudget } = require("./distill.js");
  const spools = classifySpools(graph, session);
  const stats = {
    sessions: 0,
    found: 0,
    cleared: 0,
    kept: 0,
    retained: { live: 0, unknown: 0, other_tenant: 0, unattributed: 0 },
    stopped: null,
  };
  if (!spools.length) return stats;

  const b = budget || makeSpoolBudget(Date.now(), { budgetMs: SWEEP_BUDGET_MS, resultMax: SWEEP_RESULT_MAX });
  for (const s of spools) {
    if (s.disposition !== "recover") {
      stats.retained[s.disposition] += 1;
      continue;
    }
    if (stats.sessions >= SWEEP_DIR_MAX) {
      stats.stopped = stats.stopped || "the per-pass spool cap is spent";
      stats.kept += s.results;
      continue;
    }
    if (b.expired() || b.collectExhausted()) {
      stats.stopped = stats.stopped || (b.expired() ? "the sweep budget expired" : "the per-pass result cap is spent");
      stats.kept += s.results;
      continue;
    }
    stats.sessions += 1;
    stats.found += s.results;
    // `foreign` is what keys the capture on the ORIGIN session and stamps the
    // finding to the classified file's own project; the `slug` passed as the
    // fallback for that stamp is the ORIGIN's, never this sweep's, so the
    // sweeping session's context cannot leak into a recovered finding.
    await drain({
      graph,
      slug: s.origin.slug,
      session: s.session,
      remote,
      foreign: true,
      budget: b,
    }).catch(() => {});
    // Consumed = durably captured, dead-lettered or provably uncapturable —
    // whatever is still there was deliberately KEPT (a transient failure, a
    // claim held by a concurrent drain, or a bound reached mid-dir) and stays
    // retryable for the next pass.
    // A worker the ended session left mid-classification can still land a NEW
    // result here, so this is a difference of counts, not a subtraction that
    // may go negative.
    const left = outResults(s.dir).length;
    stats.kept += left;
    stats.cleared += Math.max(0, s.results - left);
  }
  return stats;
}

function reportSweep(graph, session, slug, remote, stats) {
  const r = stats.retained;
  const retained = r.live + r.unknown + r.other_tenant + r.unattributed;
  if (!stats.sessions && !retained) return;
  const line =
    `stranded-spool sweep: cleared ${stats.cleared}/${stats.found} result(s) from ${stats.sessions} terminated session(s); ` +
    `kept ${stats.kept}; retained ${retained} spool(s) (live ${r.live}, no-terminal-evidence ${r.unknown}, ` +
    `other-tenant ${r.other_tenant}, unattributed ${r.unattributed})` +
    (stats.stopped ? ` — stopped early: ${stats.stopped}` : "");
  try {
    if (remote) u.makeLogger(path.join(graph, "journal", "remote.log"), `nudge-sweep ${slug}: `)(line);
    else u.appendLine(path.join(graph, "journal", "distill.log"), `  ${line}`);
  } catch {
    /* reporting must never break the sweep */
  }
  try {
    u.appendLine(
      path.join(graph, "journal", `${session}.jsonl`),
      JSON.stringify({
        ts: u.jqNow(),
        project: slug,
        tool: "nudge-spool-sweep",
        sessions: stats.sessions,
        found: stats.found,
        cleared: stats.cleared,
        kept: stats.kept,
        retained: r,
        ...(stats.stopped ? { stopped: stats.stopped } : {}),
      })
    );
  } catch {
    /* best effort */
  }
}

async function main() {
  const cwd = process.argv[2] || process.cwd();
  const session = process.argv[3] || "unknown";
  try {
    // Re-resolve the cascade in this process (the parent's is not inherited):
    // same cwd, same env, so mode, tenant and graph home resolve exactly as they
    // did for the session that spawned us. Re-check the gates too — the spawn
    // decision and the work are minutes apart in the worst case.
    const cfg = u.useConfig({ cwd });
    if (!cfg.enabled()) return;
    if (!u.cfgBool("nudge.async", "NUDGE_ASYNC", false)) return;
    if (!u.cfgBool("nudge.enabled", "NUDGE", true)) return;
    const graph = u.graphHome();
    const remote = Boolean(u.serverBase());
    const stats = await sweepStrandedSpools({ graph, session, remote });
    reportSweep(graph, session, u.projectSlug(cwd), remote, stats);
  } catch {
    /* fail-open, like every other detached worker */
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    () => process.exit(0)
  );
}

module.exports = {
  ORIGIN_FILE,
  writeSpoolOrigin,
  readSpoolOrigin,
  currentTenant,
  terminalSessions,
  hasSweepCandidates,
  shouldSweep,
  classifySpools,
  sweepStrandedSpools,
  reportSweep,
  SWEEP_DIR_MAX,
  SWEEP_RESULT_MAX,
};
