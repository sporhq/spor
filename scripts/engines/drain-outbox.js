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

async function drainOutbox(graph, tag = "drain", maxTimeSec = 30, maxFiles = 0) {
  if (!u.serverBase()) return;
  const outbox = path.join(graph, "outbox");
  if (!fs.existsSync(outbox)) return;

  u.ensureDir(path.join(graph, "journal"));
  const rlog = u.makeLogger(path.join(graph, "journal", "remote.log"), `${tag} drain: `);

  // Retries multiply wall-clock cost; with a tight per-file budget
  // (session-start) skip them so one slow file can't eat the hook budget.
  const retry = maxTimeSec <= 5 ? 0 : 2;

  let files;
  try {
    files = fs.readdirSync(outbox).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return;
  }

  let drained = 0;
  for (const name of files) {
    if (maxFiles > 0 && drained >= maxFiles) {
      rlog(`file cap (${maxFiles}) reached; deferring the rest to the next drain`);
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
    drained++;
    if (http === "200" || http === "207") {
      try {
        fs.unlinkSync(file);
      } catch {}
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
      if (http === "401") {
        rlog(
          `dead-lettered ${name} (http=401, revoked/invalid token); ` +
            `re-mint SPOR_TOKEN and replay outbox/dead/ — auth will not recover on its own`
        );
      } else {
        rlog(`dead-lettered ${name} (http=${http}, permanent); kept in outbox/dead/ for inspection`);
      }
    } else {
      rlog(`drain failed for ${name} (http=${http}); leaving spooled`);
    }
  }
}

module.exports = { drainOutbox };

// CLI entry so session-start can fire the drain DETACHED (off the response
// critical path) the same way it fires link-commits.js — argv: tag, perFileSec,
// maxFiles. The graph home is re-derived from the environment, identical to the
// in-process call. Fail-open, always exits 0.
if (require.main === module) {
  const tag = process.argv[2] || "drain";
  const maxTimeSec = Number(process.argv[3]) || 30;
  const maxFiles = Number(process.argv[4]) || 0;
  drainOutbox(u.graphHome(), tag, maxTimeSec, maxFiles)
    .catch(() => {})
    .finally(() => process.exit(0));
}
