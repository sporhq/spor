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

const u = require("./util");
const { classifyForNudge } = require("./post-tool");

u.runSpoolWorker(process.argv[2], classifyForNudge, (job, res) =>
  res && res.nfacts >= 1 && res.facts
    ? { file: job.file, facts: res.facts, nfacts: res.nfacts, ts: u.jqNow() }
    : null
);
