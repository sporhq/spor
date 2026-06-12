#!/usr/bin/env node
// commit-inference.js — façade + CLI over the pure inference kernel
// (REFACTOR.md §1 kernel/shell split). This path is the stable import; the
// scoring lives in lib/kernel/commit-inference.js. The façade owns the two
// host concerns: the $SPOR_INFER_THRESHOLD env override and the
// stdin/stdout CLI the distiller shells out to.
//
// CLI (mirrors lib/validate.js — hooks shell out to node libs):
//   echo '{"commit":{...},"candidates":[...]}' | node lib/commit-inference.js
// reads one JSON object on stdin, writes {proposals, threshold} on stdout.

"use strict";

const kernel = require("./kernel/commit-inference.js");

// opts.threshold wins, else $SPOR_INFER_THRESHOLD (legacy
// $SUBSTRATE_INFER_THRESHOLD still read), else the kernel's
// DEFAULT_THRESHOLD — same precedence as before the split.
function inferLinks(commit, candidates, opts = {}) {
  if (!(typeof opts.threshold === "number" && isFinite(opts.threshold))) {
    const env = process.env.SPOR_INFER_THRESHOLD || process.env.SUBSTRATE_INFER_THRESHOLD;
    if (env != null && env !== "") {
      const n = Number(env);
      if (isFinite(n)) opts = { ...opts, threshold: n };
    }
  }
  return kernel.inferLinks(commit, candidates, opts);
}

module.exports = {
  inferLinks,
  // exported for unit tests / reuse
  branchKeysFor: kernel.branchKeysFor,
  referencedPaths: kernel.referencedPaths,
  combine: kernel.combine,
  DEFAULT_THRESHOLD: kernel.DEFAULT_THRESHOLD,
};

// ---------------------------------------------------------------------------
// CLI — one JSON object on stdin, proposals JSON on stdout (see lib/validate.js
// for the bash-shells-out-to-node pattern the distiller uses).
// ---------------------------------------------------------------------------

if (require.main === module) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { buf += c; });
  process.stdin.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(buf || "{}");
    } catch (e) {
      process.stderr.write(`commit-inference: bad JSON on stdin: ${e.message}\n`);
      process.exit(2);
    }
    const { commit, candidates, threshold, maxProposals } = payload;
    const result = inferLinks(commit || {}, candidates || [], { threshold, maxProposals });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
  });
}
