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

// Install at most once per process, even if both load paths fire.
const FLAG = Symbol.for("spor.test.tmpCleanupInstalled");
if (!globalThis[FLAG]) {
  globalThis[FLAG] = true;

  let tmpRoot;
  try {
    tmpRoot = fs.realpathSync(os.tmpdir());
  } catch {
    tmpRoot = os.tmpdir();
  }

  const tracked = [];
  const origMkdtempSync = fs.mkdtempSync;

  fs.mkdtempSync = function (prefix, ...rest) {
    const dir = origMkdtempSync.call(this, prefix, ...rest);
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

module.exports = {};
