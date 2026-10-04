// shell/atomic-write.js — one tmp-file + rename primitive behind every
// client-side atomic write (hook caches, markers, merged host configs).
// Plain Node, zero deps.
"use strict";

// Write `data` to `file` via a uniquely-named temp file + rename, so a
// mid-write failure (disk full, permission denied) or a concurrent reader never
// observes a half-written file (rename is atomic on POSIX). Throws on
// failure — callers that want fail-open behavior wrap the call themselves.
// {mkdir: true} creates a missing parent directory first (a fresh graph
// home / repo checkout may not have it yet). This is spool.js's writer — one
// temp-naming scheme (pid + random suffix) for every atomic write, so two
// in-flight writes of one target from one process cannot share a temp file.
const { writeSpoolFile } = require("./spool.js");

const writeFileAtomic = writeSpoolFile;

module.exports = { writeFileAtomic };
