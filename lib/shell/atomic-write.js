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
const fs = require("fs");
const path = require("path");
const { writeSpoolFile } = require("./spool.js");

const writeFileAtomic = writeSpoolFile;

// The path a rename-based write of `file` must land on so a symlinked file
// keeps its link: the fully resolved target, INCLUDING a dangling one (a
// dotfiles link whose target was never created). realpath alone throws on a
// dangling link, and falling back to `file` would rename a regular file OVER
// the link. Not a link (or absent) -> `file` itself.
function symlinkTarget(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    /* absent, or a dangling link — follow it by hand */
  }
  let cur = file;
  for (let hops = 0; hops < 40; hops++) {
    let link;
    try {
      if (!fs.lstatSync(cur).isSymbolicLink()) return cur;
      link = fs.readlinkSync(cur);
    } catch {
      return cur; // absent: write here
    }
    // The kernel resolves a relative link against the link's REAL parent
    // (`..` included), not its spelled one — a home dir that is itself a link.
    let dir = path.dirname(cur);
    try {
      dir = fs.realpathSync(dir);
    } catch {
      /* parent unresolvable — the spelled one */
    }
    cur = path.resolve(dir, link);
  }
  throw Object.assign(new Error(`too many symbolic links: ${file}`), { code: "ELOOP" });
}

module.exports = { writeFileAtomic, symlinkTarget };
