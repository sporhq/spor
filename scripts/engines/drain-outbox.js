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
async function drainOutbox(graph, tag = "drain", maxTimeSec = 30, maxFiles = 0, maxWallSec = 0) {
  const summary = { attempted: 0, drained: 0, deadLettered: 0, failed: 0 };
  if (!u.serverBase()) return summary;
  const outbox = path.join(graph, "outbox");
  if (!fs.existsSync(outbox)) return summary;

  u.ensureDir(path.join(graph, "journal"));
  const rlog = u.makeLogger(path.join(graph, "journal", "remote.log"), `${tag} drain: `);

  // Retries multiply wall-clock cost; with a tight per-file budget
  // (session-start) skip them so one slow file can't eat the hook budget.
  const retry = maxTimeSec <= 5 ? 0 : 2;

  const attempts = path.join(outbox, ".attempts");
  const stampOf = (name) => path.join(attempts, name);
  const clearStamp = (name) => {
    try {
      fs.rmSync(stampOf(name), { force: true });
    } catch {}
  };
  let files;
  try {
    files = fs
      .readdirSync(outbox)
      .filter((f) => f.endsWith(".json"))
      .map((name) => {
        let m = 0;
        try {
          m = fs.statSync(stampOf(name)).mtimeMs;
        } catch {
          try {
            m = fs.statSync(path.join(outbox, name)).mtimeMs;
          } catch {}
        }
        return { name, m };
      })
      .sort((a, b) => a.m - b.m || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((e) => e.name);
  } catch {
    return summary;
  }
  // A stamp whose file is gone (drained or dead-lettered by another drain) is
  // litter; prune it so the sidecar dir stays bounded by the outbox itself.
  try {
    const live = new Set(files);
    for (const s of fs.readdirSync(attempts)) if (!live.has(s)) clearStamp(s);
  } catch {}

  const deadline = maxWallSec > 0 ? Date.now() + maxWallSec * 1000 : 0;
  for (const name of files) {
    if (maxFiles > 0 && summary.attempted >= maxFiles) {
      rlog(`file cap (${maxFiles}) reached; deferring the rest to the next drain`);
      break;
    }
    if (deadline && Date.now() >= deadline) {
      rlog(`time budget (${maxWallSec}s) spent; deferring the rest to the next drain`);
      break;
    }
    const file = path.join(outbox, name);
    const endpoint = name.endsWith(".capture.json") ? "/v1/capture" : "/v1/nodes";
    let body;
    try {
      body = fs.readFileSync(file);
    } catch {
      continue;
    }
    const { http } = await u.curl(`${u.serverBase()}${endpoint}`, {
      method: "POST",
      headers: { ...u.bearer(), "Content-Type": "application/json" },
      body,
      timeoutMs: maxTimeSec * 1000,
      retry,
    });
    summary.attempted++;
    if (http === "200" || http === "207") {
      try {
        fs.unlinkSync(file);
      } catch {}
      clearStamp(name);
      summary.drained++;
      rlog(`drained ${name} (http=${http})`);
    } else if (http === "401" || http === "403" || http === "400" || http === "413" || http === "422") {
      // Permanent client error: dead-letter it so it can't starve the drain.
      // A 401 means the token is revoked/invalid (dec-cc-fail-open-hooks: 4xx
      // is dead-lettered) — re-POSTing it on every session start and distill
      // cycle never succeeds, so it gets the same treatment, but louder: the
      // fix is a new token, not patience.
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
      if (http === "401") {
        rlog(
          `dead-lettered ${name} (http=401, revoked/invalid token); ` +
            `re-mint SPOR_TOKEN and replay outbox/dead/ — auth will not recover on its own`
        );
      } else {
        rlog(`dead-lettered ${name} (http=${http}, permanent); kept in outbox/dead/ for inspection`);
      }
    } else {
      summary.failed++;
      // Re-stamp the attempt so this file rotates behind every file not yet
      // tried: a head that keeps failing no longer starves the queue.
      try {
        u.ensureDir(attempts);
        fs.writeFileSync(stampOf(name), "");
        const now = new Date();
        fs.utimesSync(stampOf(name), now, now);
      } catch {}
      rlog(`drain failed for ${name} (http=${http}); leaving spooled`);
    }
  }
  return summary;
}

module.exports = { drainOutbox };

// CLI entry so session-start can fire the drain DETACHED (off the response
// critical path) the same way it fires link-commits.js — argv: tag, perFileSec,
// maxFiles, maxWallSec. The graph home is re-derived from the environment,
// identical to the in-process call. Fail-open, always exits 0.
if (require.main === module) {
  const tag = process.argv[2] || "drain";
  const maxTimeSec = Number(process.argv[3]) || 30;
  const maxFiles = Number(process.argv[4]) || 0;
  const maxWallSec = Number(process.argv[5]) || 0;
  drainOutbox(u.graphHome(), tag, maxTimeSec, maxFiles, maxWallSec)
    .catch(() => {})
    .finally(() => process.exit(0));
}
