"use strict";
// debounce-watcher: run the distill engine once a spooled payload has gone
// quiet. Node port of debounce-distill.sh — turn-scoped hosts (Codex Stop,
// OpenCode session.idle) fire every turn; each firing rewrites the pending
// payload, and this watcher converts "turns stopped arriving for DEBOUNCE
// seconds" into one session-end distill. Spawned detached by the dispatcher;
// one watcher per session (lock dir holds this pid). Being plain Node, it
// needs no setsid — spawn({detached}) detaches it on every platform.
//
//   node debounce-watcher.js <pending-payload> <lock-dir> <quiesce-seconds>

const fs = require("fs");
const path = require("path");

const [pending, lock, debounceArg] = process.argv.slice(2);
if (!pending || !lock || !debounceArg) process.exit(0);
const debounceMs = (Number(debounceArg) || 0) * 1000;

try {
  fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
} catch {}
const releaseLock = () => {
  try {
    fs.rmSync(lock, { recursive: true, force: true });
  } catch {}
};
process.on("exit", releaseLock);

const mtime = (f) => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return null;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runDistill() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(pending, "utf8"));
  } catch {
    return;
  }
  // Activate the client config cascade from the session cwd so this detached
  // watcher resolves the SAME graph home (and distill settings) the session used
  // — in particular a per-repo `.spor` `graph:` marker home
  // (issue-cc-local-mode-graph-sharing-gap). The in-process distill path gets
  // this from the dispatcher; the watcher is a fresh process with no active
  // config, so without this the debounced distiller would write to the env/
  // default home and bypass the shared graph. Fail-open: a config error leaves
  // the prior env/default resolution.
  try {
    require(path.join(__dirname, "util")).useConfig({ cwd: payload.cwd || process.cwd() });
  } catch {
    /* fall back to env/default home */
  }
  const { distill } = require("./distill");
  await distill(payload).catch(() => {});
}

(async () => {
  // Cap the watch at 96 rounds (~24h at the 900s default) so a watcher can
  // never outlive its usefulness.
  for (let i = 0; i < 96; i++) {
    const m0 = mtime(pending);
    if (m0 === null) process.exit(0);
    await sleep(debounceMs);
    const m1 = mtime(pending);
    if (m1 === null) process.exit(0);
    if (m0 === m1) break;
  }
  await runDistill();
  try {
    fs.unlinkSync(pending);
  } catch {}
  process.exit(0);
})();
