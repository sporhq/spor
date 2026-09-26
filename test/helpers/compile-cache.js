"use strict";

// V8 compile cache for the test run (task-spor-test-suite-runtime-budget).
//
// Most of the suite's wall time is spawned `bin/spor.js` / `bin/spor-hook.js`
// processes, and a large share of each spawn is parsing and compiling the
// ~23k-line CLI plus the lib/ modules it requires — identical work repeated
// thousands of times per run. Node's on-disk compile cache (22.1+) skips it
// after the first spawn. Setting NODE_COMPILE_CACHE here, in the `--require`d
// preload, reaches every per-file test child AND every grandchild CLI those
// tests spawn, since they inherit process.env (a test that builds its env from
// scratch just runs uncached — the cache is an optimization, never a
// behavior). The cache is keyed on file content, so a stale entry is simply
// missed, and a directory we cannot create just means no cache.
//
// Opt out with NODE_COMPILE_CACHE= (empty) or NODE_DISABLE_COMPILE_CACHE=1.

const os = require("node:os");
const path = require("node:path");

if (process.env.NODE_COMPILE_CACHE === undefined && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  process.env.NODE_COMPILE_CACHE = path.join(os.tmpdir(), "spor-test-node-compile-cache");
}
if (process.env.NODE_COMPILE_CACHE) {
  try {
    const mod = require("node:module");
    if (typeof mod.enableCompileCache === "function") mod.enableCompileCache(process.env.NODE_COMPILE_CACHE);
  } catch { /* no cache — tests run exactly as before */ }
}
