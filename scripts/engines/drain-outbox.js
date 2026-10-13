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
// A /v1/nodes batch answered 2xx without per-entry results this many times is
// dead-lettered rather than rotated forever.
const RESULTLESS_MAX = 5;
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
  // A plain rename, not spool.js replaceFileSync: this drain claimed the base
  // name away, so the target is normally absent and no process reads it open
  // (a drain claims by rename before it reads) — and a failure here is benign.
  const release = (file, name) => {
    try {
      fs.renameSync(file, path.join(outbox, name));
    } catch {}
  };
  // The stamp's CONTENT is the count of 2xx answers that carried no
  // per-entry results (settleNodes); any other attempt keeps it as it stands.
  const stampAttempt = (name, resultless = null) => {
    try {
      u.ensureDir(attempts);
      if (resultless != null) fs.writeFileSync(stampOf(name), String(resultless));
      else fs.closeSync(fs.openSync(stampOf(name), "a"));
      const now = new Date();
      fs.utimesSync(stampOf(name), now, now);
    } catch {}
  };
  const resultlessCount = (name) => {
    try {
      return Number(fs.readFileSync(stampOf(name), "utf8").trim()) || 0;
    } catch {
      return 0;
    }
  };
  // The three settled outcomes every endpoint's settle function ends in, each
  // owning its tally: DRAINED (the file is done with), DEAD-LETTERED (kept in
  // outbox/dead/ under deadLetterFile's never-overwrite rule), or KEPT
  // spooled for a later drain (`stamp` rotates it behind every untried file,
  // so a head that keeps failing never starves the queue).
  const drained = (f, what) => {
    try {
      fs.unlinkSync(f.file);
    } catch {}
    clearStamp(f.name);
    summary.drained++;
    rlog(what);
  };
  const keep = (f, what, { stamp = true, resultless = null } = {}) => {
    summary.failed++;
    if (stamp) stampAttempt(f.name, resultless);
    release(f.file, f.name);
    rlog(what);
  };
  // A dead-letter that cannot reach outbox/dead/ keeps the file spooled
  // rather than discarding it: a permanent reject is preserved, never lost
  // (API.md §5), and the attempt stamp keeps it from blocking the rest.
  const deadLetter = (f, what) => {
    try {
      const dir = path.join(outbox, "dead");
      if (!u.ensureDir(dir)) throw new Error("no dead-letter dir");
      u.deadLetterFile(dir, f.name, { from: f.file });
    } catch {
      keep(f, `${what} — but the dead-letter write failed; left spooled`);
      return;
    }
    clearStamp(f.name);
    summary.deadLettered++;
    rlog(what);
  };

  // A non-2xx answer to either endpoint. `replaySafe`: a re-POST of these
  // exact bytes cannot double-apply (a keyed capture — the server replays its
  // pinned answer), so even a 5xx the server marked non-replayable stays
  // spooled; anything else it marked so is dead-lettered for inspection.
  const settleFailure = (f, { replaySafe }) => {
    const { http, kind } = f;
    if (f.reply && !busy.serverAllowsReplay(f.reply) && !replaySafe) {
      deadLetter(f, `dead-lettered ${f.name} (http=${http}, the server marked it non-replayable); kept in outbox/dead/ for inspection`);
    } else if (kind === "auth") {
      // A token revoked/invalid even after curlWithRefresh's one refresh
      // (dec-cc-fail-open-hooks): re-POSTing never succeeds, so it is
      // dead-lettered like any permanent reject, but louder — the fix is a new
      // token, not patience.
      deadLetter(
        f,
        `dead-lettered ${f.name} (http=${http}, revoked/invalid token); ` +
          `re-mint SPOR_TOKEN and replay outbox/dead/ — auth will not recover on its own`
      );
    } else if (u.isPermanentHttpFailure(kind)) {
      deadLetter(f, `dead-lettered ${f.name} (http=${http}, permanent); kept in outbox/dead/ for inspection`);
    } else {
      keep(f, `drain failed for ${f.name} (http=${http}); leaving spooled`);
    }
  };

  // `*.capture.json` -> /v1/capture.
  const settleCapture = async (f) => {
    const outcome = u.captureOutcome(f.res);
    // A capture whose idempotency key the server pins replays its original
    // answer, so a re-POST of it can never double-apply.
    const keyed = Boolean(f.sent && typeof f.sent.idempotency_key === "string" && f.sent.idempotency_key !== "");
    if (outcome.unsaved) {
      // FINAL (task-spor-client-capture-partial-unsaved-handling): the
      // capture is never re-sent; its deferred drafts are re-submitted as
      // node writes, and what did not land is handed to the outbox as a
      // replay-safe /v1/nodes batch. Only if that handoff did not reach disk
      // does a KEYED capture stay spooled (its replay answers the identical
      // pinned body, drafts included); an unkeyed one is dead-lettered.
      const stem = f.name.slice(0, -".capture.json".length);
      const { durable } = await u.settlePartialUnsaved(graph, outcome.unsaved, { stem, log: (m) => rlog(`${f.name}: ${m}`), timeoutMs: maxTimeSec * 1000 });
      if (durable) drained(f, `settled ${f.name} (http=${f.http}, partial_unsaved)`);
      else if (keyed) keep(f, `kept ${f.name} spooled: its deferred drafts could not be saved (a keyed replay returns them again)`, { stamp: false });
      else deadLetter(f, `dead-lettered ${f.name} (http=${f.http}, partial_unsaved; deferred drafts not saved)`);
    } else if (f.kind === "ok") {
      if (outcome.partial) rlog(`${f.name}: ${capturePartial.describePartialCapture(outcome.partial)}`);
      drained(f, `drained ${f.name} (http=${f.http})`);
    } else {
      settleFailure(f, { replaySafe: keyed });
    }
  };

  // `*.json` -> /v1/nodes. Every client writer spools a `{nodes, if_exists:
  // "skip"}` batch (settlePartialUnsaved, `spor add`'s deferred drafts, a
  // 207's re-spooled remainder), whose per-entry verdicts are read here; a
  // file without a `nodes` array (a legacy single-node body) has no entries
  // to split, so its 2xx is its own success. A refused entry is dead-lettered,
  // never read as landed — for a skip batch an existing id re-reads as
  // `skipped` (landed), so a refusal is the server's verdict on the content;
  // a legacy NON-skip batch's `already_exists` may be its own earlier landing,
  // which dead-lettering preserves for inspection rather than dropping.
  const settleNodes = (f) => {
    if (f.kind !== "ok") return settleFailure(f, { replaySafe: false });
    const sent = f.sent;
    if (!sent || !Array.isArray(sent.nodes)) return drained(f, `drained ${f.name} (http=${f.http})`);
    const split = capturePartial.splitNodesResults(u.parseJsonOrNull(f.res.body || ""), sent);
    // A 2xx whose per-entry results are missing or not one per entry says
    // nothing about which entries landed: the batch stays whole and spooled —
    // but a server that NEVER answers it with results would rotate it forever,
    // so after RESULTLESS_MAX such answers it is dead-lettered for inspection
    // (a skip batch, so replaying it from outbox/dead/ stays safe).
    if (!split) {
      const n = resultlessCount(f.name) + 1;
      if (n >= RESULTLESS_MAX) {
        return deadLetter(f, `dead-lettered ${f.name}: ${n} http=2xx answers carried no per-entry results for its ${sent.nodes.length} entr(ies); kept in outbox/dead/ for inspection`);
      }
      return keep(f, `kept ${f.name} spooled: http=${f.http} carried no per-entry results for its ${sent.nodes.length} entr(ies) (${n}/${RESULTLESS_MAX})`, { resultless: n });
    }
    if (!split.retry && !split.dead) return drained(f, `drained ${f.name} (http=${f.http})`);
    // Dead-letter the refused entries first; only once they are safely in
    // outbox/dead/ may the file shrink to the re-sendable ones, otherwise it
    // stays whole (a skip replay of the landed entries is harmless).
    let ok = !split.dead || u.spoolNodesBody(graph, f.name, split.dead, { dead: true });
    if (ok && split.retry) {
      try {
        u.writeSpoolFile(f.file, JSON.stringify(split.retry));
      } catch {
        ok = false;
      }
    }
    const tally = `${split.landed}/${sent.nodes.length} of ${f.name} (http=${f.http})`;
    const refused = split.dead ? `${split.dead.nodes.length} refused, dead-lettered to outbox/dead/` : "";
    if (!ok) {
      keep(f, `drain of ${f.name} partly landed (http=${f.http}) but its refused entries could not be dead-lettered; leaving the file whole`, { stamp: false });
    } else if (split.retry) {
      keep(f, `drained ${tally}; ${split.retry.nodes.length} busy entr(ies) left spooled` + (refused ? `, ${refused}` : ""), { resultless: 0 });
    } else {
      // Everything sent either landed or now sits in outbox/dead/.
      try {
        fs.unlinkSync(f.file);
      } catch {}
      clearStamp(f.name);
      summary.deadLettered++;
      rlog(`drained ${tally}; ${refused}`);
    }
  };

  const drainOne = async (claimedName, name) => {
    const file = path.join(outbox, claimedName);
    const isCapture = name.endsWith(".capture.json");
    let body;
    try {
      body = fs.readFileSync(file);
    } catch {
      release(file, name);
      return;
    }
    const res = await u.curlWithRefresh(`${u.serverBase()}${isCapture ? "/v1/capture" : "/v1/nodes"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      timeoutMs: maxTimeSec * 1000,
      retry,
    });
    summary.attempted++;
    const { http } = res;
    const f = {
      file,
      name,
      res,
      http,
      kind: u.classifyHttpFailure(http),
      sent: u.parseJsonOrNull(body.toString("utf8")),
      reply: Number(http) >= 500 ? { status: Number(http), json: u.parseJsonOrNull(res.body || "") } : null,
    };
    await (isCapture ? settleCapture(f) : settleNodes(f));
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

module.exports = { drainOutbox, RESULTLESS_MAX };

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
