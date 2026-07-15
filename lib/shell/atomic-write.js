// shell/atomic-write.js — one tmp-file + rename primitive behind every
// client-side atomic write (hook caches, markers, merged host configs).
// Plain Node, zero deps, leaf module (no dependents inside lib/).
"use strict";

const fs = require("fs");
const path = require("path");

// Write `data` to `file` via a pid-scoped temp file + rename, so a mid-write
// failure (disk full, permission denied) or a concurrent reader never
// observes a half-written file (rename is atomic on POSIX). Throws on
// failure — callers that want fail-open behavior wrap the call themselves.
// {mkdir: true} creates a missing parent directory first (a fresh graph
// home / repo checkout may not have it yet).
function writeFileAtomic(file, data, opts = {}) {
  if (opts.mkdir) fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw e;
  }
}

module.exports = { writeFileAtomic };
