"use strict";
// One classification, run in its own process for scripts/intent-eval/run.js.
//
// The shipped classifier (prompt-context.js's classifyDigestIntent, run by
// digest-worker.js) is SYNCHRONOUS — it spawnSync's the backend — so the eval
// gets its concurrency from processes rather than from a re-implementation of
// the call. That is the point of this file: the harness must never carry its
// own copy of the backend invocation or the verdict parse, or it would score a
// classifier that is not the one that ships (the scratchpad harness this was
// committed from did carry one).
//
//   echo '<job json>' | node classify-one.js <engine-root>

const fs = require("fs");
const path = require("path");

const engineRoot = process.argv[2];
const { classifyDigestIntent } = require(path.join(engineRoot, "scripts", "engines", "prompt-context.js"));

const job = JSON.parse(fs.readFileSync(0, "utf8"));
const t0 = Date.now();
let verdict = null;
let error = null;
try {
  verdict = classifyDigestIntent(job);
} catch (e) {
  error = String((e && e.message) || e);
}
process.stdout.write(JSON.stringify({
  verdict,                          // WARRANTED | UNWARRANTED | null (fail-open)
  inject: verdict !== "UNWARRANTED", // the worker's effective decision
  ms: Date.now() - t0,
  error,
}) + "\n");
