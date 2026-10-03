// node --test reporter that records how a FILE died outside any test
// (task-split-spor-bf14e0e45235). scripts/test-run.js loads it beside the
// human reporter and reads the JSON it writes to $SPOR_TEST_CRASH_REPORT.
//
// A file whose process exits non-zero (or is killed) with no failing test is
// reported by node as a file-level `test:fail` carrying the child's
// `details.error.exitCode`/`.signal` — "test failed" and nothing else, with
// the child's stderr arriving separately as `test:stderr`. This keeps both:
// the exit code/signal and the last STDERR_LINES stderr lines per file, plus
// a count of failing TESTS so the runner can tell a crash-only run from a red
// one. Yields nothing: it adds no output of its own.
"use strict";

const fs = require("node:fs");

const STDERR_LINES = 12;
const STDERR_KEEP_BYTES = 16384;

module.exports = async function* crashReporter(source) {
  const tails = new Map(); // file -> trailing stderr text
  const crashed = [];
  let failedTests = 0;
  for await (const ev of source) {
    const d = ev.data || {};
    if (ev.type === "test:stderr" && d.file) {
      const prior = tails.get(d.file) || "";
      tails.set(d.file, (prior + String(d.message || "")).slice(-STDERR_KEEP_BYTES));
    } else if (ev.type === "test:fail") {
      const err = (d.details && d.details.error) || {};
      // The record is the exitCode/signal node attaches to the file's OWN error
      // — never the test's name (a leaf test may be named after its file) and
      // never a property on a `cause` (that is an error a test threw).
      const died = d.file && (err.exitCode != null || err.signal != null);
      if (died) {
        crashed.push({ file: d.file, exitCode: err.exitCode ?? null, signal: err.signal ?? null });
      } else if (err.failureType !== "subtestsFailed" || d.name !== d.file) {
        // a failing test, or any non-crash file-level failure (cancelled,
        // unparseable): not something a re-run may wave through
        failedTests++;
      }
    }
  }
  for (const c of crashed) {
    c.stderr = (tails.get(c.file) || "").split(/\r?\n/).filter((l) => l.trim()).slice(-STDERR_LINES);
  }
  const dest = process.env.SPOR_TEST_CRASH_REPORT;
  if (dest) {
    try { fs.writeFileSync(dest, JSON.stringify({ crashed, failedTests })); } catch { /* best-effort */ }
  }
};
