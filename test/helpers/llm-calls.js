"use strict";

// Reads journal/llm-calls/*.jsonl — the append log recordLlm() (in
// scripts/engines/util.js) writes to with a plain fs.appendFileSync, not the
// atomic temp-file+rename runSpoolWorker uses for its `.out.json` results. A
// poll landing mid-write can hit a torn/partial line, so any test that polls
// this file while a detached worker may still be appending to it must retry
// through tryLlmCalls, not call llmCalls directly in its predicate
// (issue-spor-nudge-async-test-torn-json-read, issue-spor-digest-async-test-torn-json-read).

const fs = require("node:fs");
const path = require("node:path");

function llmCalls(home) {
  const dir = path.join(home, "journal", "llm-calls");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) =>
    fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  );
}

// Torn-read-tolerant: returns null (never throws) on a partial write instead
// of letting JSON.parse's SyntaxError escape a waitFor predicate.
function tryLlmCalls(home) {
  try {
    return llmCalls(home);
  } catch {
    return null;
  }
}

module.exports = { llmCalls, tryLlmCalls };
