"use strict";
// Drain spooled distiller payloads from $SPOR_HOME/outbox/ to the team
// server (the fail-open spooling policy, API.md §6). Node port of
// drain-outbox.sh — same two spool
// shapes (*.capture.json -> /v1/capture, *.json -> /v1/nodes), same
// caller-tunable per-file budget and file cap, same dead-letter policy for
// permanent 4xx rejects. Best-effort and fail-open throughout.

const fs = require("fs");
const path = require("path");
const u = require("./util");
const busy = require(path.join(u.ROOT, "lib", "shell", "busy.js"));
const capturePartial = require(path.join(u.ROOT, "lib", "shell", "capture-partial.js"));

// Returns a { attempted, drained, deadLettered, failed } tally so a caller (the
// `spor drain` verb) can report the outcome; the detached/session-start callers
// ignore it.
//
// No file may block the ones behind it (issue-spor-outbox-drain-file-cap-hol-block):
// files are taken OLDEST-ATTEMPT first — a file's last failed attempt, else its
// spool time (mtime) — and a transient failure stamps the attempt, rotating
// that file behind everything not yet tried, so a capped drain that keeps
// failing on one file still reaches every other file on later passes. The
// attempt stamp is a sidecar (`outbox/.attempts/<name>`, its mtime) rather than
// the file's own mtime, which stays the SPOOL time: `spor-hook doctor` reports
// the outbox's oldest mtime as how long captures have been stuck, and an
// outage must not read as minutes old because every drain re-stamped it. `maxWallSec` (0 = none) bounds
// the whole pass besides the per-file `maxTimeSec` and the `maxFiles` cap.
// Outbox files this process is draining right now, by unclaimed path.
const inFlight = new Set();
const suffixOf = (name) => (name.endsWith(".capture.json") ? ".capture.json" : ".json");

async function drainOutbox(graph, { tag = "drain", maxTimeSec = 30, maxFiles = 0, maxWallSec = 0, retryOverride = null } = {}) {
  const summary = { attempted: 0, drained: 0, deadLettered: 0, failed: 0 };
  if (!u.serverBase()) return summary;
  const outbox = path.join(graph, "outbox");
  if (!fs.existsSync(outbox)) return summary;

  u.ensureDir(path.join(graph, "journal"));
  const rlog = u.makeLogger(path.join(graph, "journal", "remote.log"), `${tag} drain: `);

  // Retries multiply wall-clock cost; with a tight per-file budget
  // (session-start) skip them so one slow file can't eat the hook budget. A
  // caller may pin the count instead: a window already sized to cover a slow
  // ingest gains nothing from re-POSTing the same bytes while the first is
  // still in flight server-side.
  const retry = retryOverride != null ? retryOverride : maxTimeSec <= 5 ? 0 : 2;

  const attempts = path.join(outbox, ".attempts");
  const stampOf = (name) => path.join(attempts, name);
  const clearStamp = (name) => {
    try {
      fs.rmSync(stampOf(name), { force: true });
    } catch {}
  };
  // Every outbox entry is claimed by RENAME before it is read or POSTed
  // (u.claimSpoolResult, the one spool claim — lib/shell/spool.js), because
  // session-start's detached drain, distill, and `spor drain` can overlap on
  // one outbox and a read→POST→unlink with no claim sent the same capture
  // twice. A claimed name keeps its spool suffix (`.capture.json` / `.json`),
  // so it still routes to the same endpoint, still counts in doctor's outbox
  // depth/age (u.spoolStats globs *.json), and a drain that crashes mid-POST
  // strands nothing: a live owner's claim is skipped, a dead or expired one
  // (SPOOL_TTL.claimHold) is re-claimed. Stamps and dead-letter names use the
  // UNCLAIMED base name, so the attempt rotation survives claim and release.
  let files;
  try {
    files = fs
      .readdirSync(outbox)
      .filter((f) => f.endsWith(".json"))
      .map((name) => {
        const suffix = suffixOf(name);
        const base = u.spoolResultHash(name, suffix) + suffix;
        let m = 0;
        try {
          m = fs.statSync(stampOf(base)).mtimeMs;
        } catch {
          try {
            m = fs.statSync(path.join(outbox, name)).mtimeMs;
          } catch {}
        }
        return { name, base, suffix, m };
      })
      .sort((a, b) => a.m - b.m || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return summary;
  }
  // A stamp whose file is gone (drained or dead-lettered by another drain) is
  // litter; prune it so the sidecar dir stays bounded by the outbox itself.
  try {
    const live = new Set(files.map((e) => e.base));
    for (const s of fs.readdirSync(attempts)) if (!live.has(s)) clearStamp(s);
  } catch {}

  const deadline = maxWallSec > 0 ? Date.now() + maxWallSec * 1000 : 0;
  // Hand a claimed file back under its base name so a later drain retries it.
  // If even that rename fails the claimed name still ends in .json: it stays
  // counted, and is re-claimable once this process exits or the hold expires.
  const release = (file, name) => {
    try {
      fs.renameSync(file, path.join(outbox, name));
    } catch {}
  };
  const stampAttempt = (name) => {
    try {
      u.ensureDir(attempts);
      fs.writeFileSync(stampOf(name), "");
      const now = new Date();
      fs.utimesSync(stampOf(name), now, now);
    } catch {}
  };
  const deadLetter = (file, name, what) => {
    try {
      u.ensureDir(path.join(outbox, "dead"));
      fs.renameSync(file, path.join(outbox, "dead", name));
    } catch {
      try {
        fs.unlinkSync(file);
      } catch {}
    }
    clearStamp(name);
    summary.deadLettered++;
    rlog(what);
  };
  const drainOne = async (claimedName, name) => {
    const file = path.join(outbox, claimedName);
    const endpoint = name.endsWith(".capture.json") ? "/v1/capture" : "/v1/nodes";
    let body;
    try {
      body = fs.readFileSync(file);
    } catch {
      release(file, name);
      return;
    }
    const res = await u.curlWithRefresh(`${u.serverBase()}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      timeoutMs: maxTimeSec * 1000,
      retry,
    });
    const { http } = res;
    summary.attempted++;
    const kind = u.classifyHttpFailure(http);
    const sent = u.parseJsonOrNull(body.toString("utf8"));
    const isCapture = endpoint === "/v1/capture";
    const outcome = isCapture ? u.captureOutcome(res) : {};
    const reply = Number(http) >= 500 ? { status: Number(http), json: u.parseJsonOrNull(res.body || "") } : null;
    // A capture whose idempotency key the server pins replays its original
    // answer, so a re-POST of it can never double-apply.
    const keyed = isCapture && sent && typeof sent.idempotency_key === "string" && sent.idempotency_key !== "";
    // A /v1/nodes answer's per-entry verdicts: a 207 whose busy entries wrote
    // nothing keeps exactly those spooled, and dead-letters the refused ones,
    // instead of reading the whole file as drained.
    const split = !isCapture && kind === "ok" ? capturePartial.splitNodesResults(u.parseJsonOrNull(res.body || ""), sent) : null;
    const unlinkDrained = (what) => {
      try {
        fs.unlinkSync(file);
      } catch {}
      clearStamp(name);
      summary.drained++;
      rlog(what);
    };
    if (outcome.unsaved) {
      // FINAL (task-spor-client-capture-partial-unsaved-handling): the
      // capture is never re-sent; its deferred drafts are re-submitted as
      // node writes, and what did not land is handed to the outbox as a
      // replay-safe /v1/nodes batch. Only if that handoff did not reach disk
      // does a KEYED capture stay spooled (its replay answers the identical
      // pinned body, drafts included); an unkeyed one is dead-lettered.
      const stem = name.slice(0, -".capture.json".length);
      const { durable } = await u.settlePartialUnsaved(graph, outcome.unsaved, { stem, log: (m) => rlog(`${name}: ${m}`), timeoutMs: maxTimeSec * 1000 });
      if (durable) unlinkDrained(`settled ${name} (http=${http}, partial_unsaved)`);
      else if (keyed) {
        summary.failed++;
        release(file, name);
        rlog(`kept ${name} spooled: its deferred drafts could not be saved (a keyed replay returns them again)`);
      } else deadLetter(file, name, `dead-lettered ${name} (http=${http}, partial_unsaved; deferred drafts not saved)`);
    } else if (kind === "ok" && split && (split.retry || split.dead)) {
      // Rewrite the file to the entries a re-send may still land, and
      // dead-letter the refused ones under the same name.
      let ok = true;
      if (split.dead) ok = u.spoolNodesBody(graph, name, split.dead, { dead: true }) && ok;
      // Only once the refused entries are safely dead-lettered may the file
      // shrink to the re-sendable ones; otherwise it stays whole (a skip
      // replay of the landed entries is harmless).
      if (ok && split.retry) {
        try {
          u.writeSpoolFile(file, JSON.stringify(split.retry));
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        summary.failed++;
        release(file, name);
        rlog(`drain of ${name} partly landed (http=${http}) but its refused entries could not be dead-lettered; leaving the file whole`);
      } else if (split.retry) {
        summary.failed++;
        stampAttempt(name);
        release(file, name);
        rlog(
          `drained ${split.landed}/${sent.nodes.length} of ${name} (http=${http}); ${split.retry.nodes.length} busy entr(ies) left spooled` +
            (split.dead ? `, ${split.dead.nodes.length} refused (outbox/dead/${name})` : "")
        );
      } else {
        try {
          fs.unlinkSync(file);
        } catch {}
        clearStamp(name);
        summary.deadLettered++;
        rlog(`drained ${split.landed}/${sent.nodes.length} of ${name} (http=${http}); ${split.dead.nodes.length} refused, dead-lettered to outbox/dead/${name}`);
      }
    } else if (kind === "ok") {
      if (outcome.partial) rlog(`${name}: ${capturePartial.describePartialCapture(outcome.partial)}`);
      unlinkDrained(`drained ${name} (http=${http})`);
    } else if (reply && !busy.serverAllowsReplay(reply) && !keyed) {
      // The server said a re-send of these bytes may double-apply (a busy
      // marked `retryable: false`): re-POSTing it every drain is the hazard,
      // so it is dead-lettered for inspection rather than kept transient.
      deadLetter(file, name, `dead-lettered ${name} (http=${http}, the server marked it non-replayable); kept in outbox/dead/ for inspection`);
    } else if (u.isPermanentHttpFailure(kind)) {
      // Permanent (u.classifyHttpFailure): dead-letter it so it can't starve
      // the drain. An auth failure means the token is revoked/invalid
      // (dec-cc-fail-open-hooks: 4xx is dead-lettered) — re-POSTing it on
      // every session start and distill cycle never succeeds, so it gets the
      // same treatment, but louder: the fix is a new token, not patience.
      try {
        u.ensureDir(path.join(outbox, "dead"));
        fs.renameSync(file, path.join(outbox, "dead", name));
      } catch {
        try {
          fs.unlinkSync(file);
        } catch {}
      }
      clearStamp(name);
      summary.deadLettered++;
      if (kind === "auth") {
        rlog(
          `dead-lettered ${name} (http=${http}, revoked/invalid token); ` +
            `re-mint SPOR_TOKEN and replay outbox/dead/ — auth will not recover on its own`
        );
      } else {
        rlog(`dead-lettered ${name} (http=${http}, permanent); kept in outbox/dead/ for inspection`);
      }
    } else {
      summary.failed++;
      // Re-stamp the attempt so this file rotates behind every file not yet
      // tried: a head that keeps failing no longer starves the queue.
      stampAttempt(name);
      // Release the claim (rename back) so the file is retried later.
      release(file, name);
      rlog(`drain failed for ${name} (http=${http}); leaving spooled`);
    }
  };
  for (const { name: entry, base: name, suffix } of files) {
    if (maxFiles > 0 && summary.attempted >= maxFiles) {
      rlog(`file cap (${maxFiles}) reached; deferring the rest to the next drain`);
      break;
    }
    if (deadline && Date.now() >= deadline) {
      rlog(`time budget (${maxWallSec}s) spent; deferring the rest to the next drain`);
      break;
    }
    // The claim honors other LIVE pids; an overlapping drain in this same
    // process (distill's in-process drain vs `spor drain`) carries our own pid,
    // which the claim treats as retakeable, so it is fenced here instead.
    const key = path.join(outbox, name);
    if (inFlight.has(key)) continue;
    const claimedName = u.claimSpoolResult(outbox, entry, undefined, suffix);
    if (!claimedName) continue; // held by a live drain, or already taken
    inFlight.add(key);
    try {
      await drainOne(claimedName, name);
    } finally {
      inFlight.delete(key);
    }
  }
  return summary;
}

module.exports = { drainOutbox };

// CLI entry so session-start can fire the drain DETACHED (off the response
// critical path) the same way it fires link-commits.js — argv: tag, perFileSec,
// maxFiles, maxWallSec[, retry]. The graph home is re-derived from the environment,
// identical to the in-process call. Fail-open, always exits 0.
if (require.main === module) {
  const tag = process.argv[2] || "drain";
  const maxTimeSec = Number(process.argv[3]) || 30;
  const maxFiles = Number(process.argv[4]) || 0;
  const maxWallSec = Number(process.argv[5]) || 0;
  const retryArg = process.argv[6];
  const retryOverride = retryArg != null && /^\d+$/.test(retryArg) ? Number(retryArg) : null;
  drainOutbox(u.graphHome(), { tag, maxTimeSec, maxFiles, maxWallSec, retryOverride })
    .catch(() => {})
    .finally(() => process.exit(0));
}
