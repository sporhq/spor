"use strict";
// Capture-pipeline health scan (task-spor-distill-nudge-health-diagnostics).
// The fail-open contract (dec-cc-fail-open-hooks) makes a dead capture
// pipeline look exactly like a quiet healthy one: the 2026-06 home-migration
// outage (issue-spor-distill-nudge-silent-failure-home-migration) ran 20 days
// at 100% failure with zero operator-visible signal. But every distill and
// nudge backend call ALREADY writes a success-or-error record to
// journal/llm-calls/<local-date>.jsonl — so the streak is computable after
// the fact from data we have. This module reads a trailing window of those
// day files (tail-bounded, so a heavy fleet day can't blow the hook budget)
// and reports per-pipeline attempts/failures; a pipeline with MIN_ATTEMPTS+
// calls and zero successes in the window is FAILING, which doctor prints and
// session-start's degradation nudge surfaces. Read-only and fail-soft.

const fs = require("fs");
const path = require("path");
const u = require("./util");

const WINDOW_DAYS = 7;
const MIN_ATTEMPTS = 3; // fewer calls than this is "idle", never "failing"
const TAIL_BYTES = 2 * 1024 * 1024; // per-day-file read bound

// Records carry source: "distill-remote" | "distill-local" | "nudge" |
// "digest-intent" (the async digest-intent classifier, dec-spor-digest-
// async-intent-gate-implementation — off by default via SPOR_DIGEST_ASYNC,
// but when it's on a dead SPOR_DIGEST_INTENT_CMD backend fails open to
// inject-everything with zero operator signal unless this pipeline is
// watched too, issue-spor-doctor-blind-to-digest-intent).
function pipelineOf(source) {
  const s = String(source ?? "");
  if (s.startsWith("distill")) return "distill";
  if (s.startsWith("nudge")) return "nudge";
  if (s.startsWith("digest-intent")) return "digest";
  return null;
}

// Per-pipeline {attempts, failures, lastOkTs, lastErr} over the trailing
// `days` local-date files of journal/llm-calls. Missing dir/files, truncated
// tails, and unparseable lines are all skipped silently — the scan reports
// what it can prove, never throws.
function captureHealth(graph, { days = WINDOW_DAYS, now = new Date() } = {}) {
  const dir = path.join(graph, "journal", "llm-calls");
  const empty = () => ({ attempts: 0, failures: 0, lastOkTs: null, lastErr: null });
  const stats = { distill: empty(), nudge: empty(), digest: empty(), days };
  for (let i = 0; i < days; i++) {
    const file = path.join(dir, `${u.localDate(new Date(now.getTime() - i * 86400000))}.jsonl`);
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue; // no calls that day
    }
    let lines = u.byteTail(raw, TAIL_BYTES).split("\n");
    if (Buffer.byteLength(raw, "utf8") > TAIL_BYTES) lines = lines.slice(1); // drop the cut line
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const p = pipelineOf(rec.source);
      if (!p) continue;
      const s = stats[p];
      s.attempts++;
      if (rec.error == null) {
        if (s.lastOkTs == null || String(rec.ts ?? "") > s.lastOkTs) s.lastOkTs = rec.ts ?? null;
      } else {
        s.failures++;
        s.lastErr = String(rec.error);
      }
    }
  }
  return stats;
}

// The alarm condition: enough attempts to mean the pipeline is in use, and
// every one of them failed. Partial failure is visible in doctor's numbers
// but doesn't alarm — flaky ≠ dead, and the outage class this exists for
// (issue-spor-distill-nudge-silent-failure-home-migration) is total.
function failingPipelines(stats, minAttempts = MIN_ATTEMPTS) {
  return ["distill", "nudge", "digest"].filter(
    (p) => stats[p].attempts >= minAttempts && stats[p].failures === stats[p].attempts
  );
}

module.exports = { captureHealth, failingPipelines, WINDOW_DAYS, MIN_ATTEMPTS };
