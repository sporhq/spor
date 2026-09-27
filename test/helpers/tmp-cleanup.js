// Scratch-home leak guard for the test suites (issue-spor-test-mkdtemp-inode-exhaustion).
//
// The suites create scratch graph homes per test with fs.mkdtempSync under
// os.tmpdir() (norm-cc-scratch-home-for-tests) but historically never removed
// them. Across many `node --test test/*.test.js` runs these accumulated into
// tens of thousands of /tmp/substrate-test-*, /tmp/spor-*, … dirs and
// exhausted the filesystem's INODES (100% used with bytes free), surfacing as
// a mass of spurious ENOSPC "failures".
//
// Rather than thread an after/finally cleanup through ~150 inline mkdtemp call
// sites, we wrap fs.mkdtempSync once: every dir it hands out under os.tmpdir()
// is tracked and removed when the test process exits. The wrap is install-once
// (idempotent across requires) and only ever deletes paths it created under
// the temp root, so it can never touch a real home.
//
// A run killed by a timeout/SIGKILL never reaches that exit handler, so its
// scratch dirs used to just sit in /tmp forever — a fleet of agents hit this
// on 2026-09-26 and filled the dev box's root fs to 99%
// (issue-spor-test-scratch-leaks-on-killed-runs). So the wrap also encodes
// this process's pid into every dir it creates (SCRATCH_MARKER below), and on
// install sweeps os.tmpdir() for its own marked dirs whose encoded pid is
// dead and whose mtime is older than DEFAULT_STALE_AGE_MS — a killed run's
// leftovers, cleaned up by the *next* run instead of never. The marker is
// what makes this safe with other agents' runs sharing the same /tmp: a dir
// is only ever inspected, let alone removed, if it carries OUR marker (never
// an unrelated tool's temp dir) and its encoded pid is provably dead (never a
// live run's, ours or a concurrent agent's — `isPidAlive` treats "can't tell"
// as alive).
//
// Loaded two ways, belt-and-suspenders:
//   - `node --require ./test/helpers/tmp-cleanup.js --test …` in the npm
//     scripts, so the full-suite run is always covered (--require lands in each
//     per-file test child but NOT in grandchild node processes the tests spawn,
//     so a relative path stays cwd-safe);
//   - `require("./helpers/tmp-cleanup")` at the top of each test file, so a
//     direct single-file run (`node --test test/foo.test.js`) is covered too.
// Requiring the same resolved module twice is a no-op (module cache + guard).

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let tmpRoot;
try {
  tmpRoot = fs.realpathSync(os.tmpdir());
} catch {
  tmpRoot = os.tmpdir();
}

// Injected into the prefix of every dir this wrapper creates (below), right
// before mkdtemp's own random suffix — e.g. "substrate-srv-" becomes
// "substrate-srv-spor-scratch-12345-XXXXXX". Distinctive on purpose: nothing
// else in this codebase or in npm's own tmp-<pid>-* convention produces this
// exact substring, so SCRATCH_NAME_RE below can never match a dir we didn't
// create ourselves.
const SCRATCH_MARKER = "spor-scratch";
const SCRATCH_NAME_RE = new RegExp(`${SCRATCH_MARKER}-(\\d+)-[A-Za-z0-9]{6}$`);
const DEFAULT_STALE_AGE_MS = 120 * 60 * 1000; // 120 minutes

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process, i.e. provably dead. Anything else (e.g. EPERM
    // for a pid we're not allowed to signal) means we can't prove it's dead,
    // so treat it as alive and leave its dir alone.
    return !(err && err.code === "ESRCH");
  }
}

// Removes scratch dirs a killed run (SIGKILL/timeout) left behind before its
// own `process.on("exit", …)` cleanup below could fire. Only ever inspects —
// let alone removes — a direct child of `root` that carries our own
// SCRATCH_MARKER with a pid that is provably dead and an mtime older than
// maxAgeMs; anything else (no marker, live pid, too recent) is left strictly
// alone, so a concurrent agent's live run sharing this same /tmp is never at
// risk. `root` defaults to the real temp root (production use); a test passes
// its own isolated scratch dir instead, so exercising this never touches the
// real, shared /tmp.
function sweepStaleScratch(maxAgeMs = DEFAULT_STALE_AGE_MS, root = tmpRoot) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  let swept = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const m = SCRATCH_NAME_RE.exec(entry.name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isFinite(pid) || pid <= 0 || isPidAlive(pid)) continue;
    const full = path.join(root, entry.name);
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs < maxAgeMs) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      swept++;
    } catch {
      // Best-effort: a stubborn dir just waits for the next sweep.
    }
  }
  if (swept > 0) {
    console.error(`tmp-cleanup: swept ${swept} stale scratch dir(s) left by killed run(s)`);
  }
}

// Install at most once per process, even if both load paths fire.
const FLAG = Symbol.for("spor.test.tmpCleanupInstalled");
if (!globalThis[FLAG]) {
  globalThis[FLAG] = true;

  sweepStaleScratch();

  const tracked = [];
  const origMkdtempSync = fs.mkdtempSync;

  fs.mkdtempSync = function (prefix, ...rest) {
    let finalPrefix = prefix;
    try {
      // Only mark prefixes that resolve under the temp root — anything else
      // is passed through unchanged, matching the tracking check below. The
      // prefix's own path segment doesn't exist yet (mkdtemp appends the
      // random suffix to form the real dir), so realpath its PARENT dir
      // instead of the whole prefix — matching tmpRoot's own realpath'd form
      // even when the temp dir is itself a symlink (e.g. a container's /tmp).
      const resolved = path.resolve(String(prefix));
      const realParent = fs.realpathSync(path.dirname(resolved));
      if (realParent === tmpRoot || realParent.startsWith(tmpRoot + path.sep)) {
        finalPrefix = `${prefix}${SCRATCH_MARKER}-${process.pid}-`;
      }
    } catch {
      // Non-string/invalid prefix, or a parent dir that doesn't exist yet:
      // let the original call raise its own error.
    }
    const dir = origMkdtempSync.call(this, finalPrefix, ...rest);
    try {
      // Only sweep dirs we created under the temp root — never anything else.
      const real = fs.realpathSync(dir);
      if (real === tmpRoot || real.startsWith(tmpRoot + path.sep)) {
        tracked.push(dir);
      }
    } catch {
      // realpath can fail if the dir vanished already; just don't track it.
    }
    return dir;
  };

  process.on("exit", () => {
    for (const dir of tracked.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort: a dir already gone, or held open, is not worth crashing
        // the exit path over. The next full run's sweep catches stragglers.
      }
    }
  });
}

module.exports = { sweepStaleScratch, isPidAlive, SCRATCH_NAME_RE };
