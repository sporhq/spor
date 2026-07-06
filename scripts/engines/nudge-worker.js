"use strict";
// nudge-worker: run the capture classifier OFF the tool loop
// (task-cc-async-classifier-pending-result-injection). Spawned detached by the
// post-tool nudge when nudge.async is on. It reads a spool INPUT file (the
// prompt + resolved backend params the parent already computed), runs the
// classifier synchronously in this background process, and — when it finds
// capturable facts — writes a pending-RESULT file that the next
// UserPromptSubmit drains and injects with NO LLM call on the prompt path
// (norm-cc-no-llm-prompt-path). Being plain Node it needs no setsid — the
// dispatcher's spawn({detached}) detaches it on every platform (the same
// mechanism debounce-watcher.js uses).
//
// Two-phase cooldown: the parent already wrote `pending\t<file>` to
// <session>.nudged (phase 1, the reservation); this result file is phase 2
// (completion). A NOTHING verdict or a backend failure writes NO result — the
// file simply stays reserved (fail-open, no retry storm, nothing injected).
//
//   node nudge-worker.js <input-spool.in.json>

const fs = require("fs");
const path = require("path");
const u = require("./util");
const { classifyForNudge } = require("./post-tool");

const inFile = process.argv[2];
if (!inFile) process.exit(0);

let job;
try {
  job = JSON.parse(fs.readFileSync(inFile, "utf8"));
} catch {
  process.exit(0);
}
// Consume the input immediately so a duplicate worker (belt-and-suspenders)
// can't re-run the same classification.
try {
  fs.unlinkSync(inFile);
} catch {}

let res = null;
try {
  res = classifyForNudge(job);
} catch {
  /* fail-open: leave the file reserved, inject nothing */
}

if (res && res.nfacts >= 1 && res.facts && job.hash) {
  const outFile = path.join(path.dirname(inFile), `${job.hash}.out.json`);
  // Write to a temp name then rename so the prompt-time drainer (which globs
  // `*.out.json`) can never read a half-written file — rename is atomic and the
  // `.tmp` is invisible to the glob.
  const tmp = `${outFile}.tmp`;
  try {
    fs.writeFileSync(
      tmp,
      JSON.stringify({ file: job.file, facts: res.facts, nfacts: res.nfacts, ts: u.jqNow() })
    );
    fs.renameSync(tmp, outFile);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

process.exit(0);
