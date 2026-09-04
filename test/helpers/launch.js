"use strict";

// Shared waits for the dispatch suites, whose subject is always a DETACHED
// launch: the CLI returns as soon as the launch handshake resolves, and the
// agent's own side effects (a marker file, an invocation record, a run record)
// land afterwards, in processes we do not hold.
//
// A ceiling here is a BACKSTOP against a hang, never a bound on how slow a
// launch may be. A ceiling that encodes a dev box's expectation makes a launch
// that was merely SLOW read as a launch that never happened: on the two-core
// GitHub runner, under the loaded parallel suite, a launch that also cuts a git
// worktree routinely outran the fixed ceilings these suites used to carry, and
// that is how they blocked two consecutive npm publishes
// (task-spor-port-dispatch-handshake-ordering-fix). So every ceiling scales
// with the CPU the wait can actually expect, and a caller's own `timeoutMs` is
// scaled the same way — it is a base, not a bound.
//
// Where a test's SUBJECT is the timing — "dispatch returned before the run
// ended" — no ceiling here is the answer: assert ORDERING instead, by holding
// the fake harness alive until the test releases it
// (art-spor-declared-harness-dispatch-ordering-assertion).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function scale(baseMs) {
  const width = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : (os.cpus() || []).length || 1;
  // loadavg is [0, 0, 0] on Windows, where the core count alone decides. It is
  // read per wait, not once per process, so a suite that starts idle and then
  // runs five agents' worktrees concurrently is measured as it actually is.
  const free = Math.max(0.25, width - (os.loadavg()[0] || 0));
  return Math.round(baseMs * Math.min(8, Math.max(1, 4 / free)));
}

async function waitFor(read, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const end = Date.now() + scale(timeoutMs);
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= end) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Wait for CONTENT, not mere existence: every stub writes its record with one
// writeFileSync, whose truncating open() and write() are two syscalls, so under
// a loaded full suite a poll can land between them and read ''
// (art-gate-acceptance-spor-claude-bg-prose-sweep-aft-febdf471-53e607fa — a
// launch that had happened read as "launched inside the worktree" ''). No
// caller ever accepted an empty read (`assert.ok('')` fails), so this only
// removes the race.
function waitForFile(file, opts) {
  return waitFor(() => {
    try { return fs.readFileSync(file, "utf8") || null; } catch { return null; }
  }, { timeoutMs: 10000, ...opts });
}

// The detached stub writes this file WHILE we poll for it, so a torn read is
// expected under load — retry instead of failing the test on partial JSON.
function awaitJson(file, opts) {
  return waitFor(() => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }, opts);
}

// The supervisor's own run record, once it satisfies `predicate`.
function awaitRecord(home, predicate, opts) {
  const runDir = path.join(home, "journal", "dispatch");
  return waitFor(() => {
    if (!fs.existsSync(runDir)) return null;
    const file = fs.readdirSync(runDir).find((name) => name.endsWith(".run.json"));
    if (!file) return null;
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(runDir, file), "utf8")); } catch { return null; }
    return predicate(record) ? record : null;
  }, opts);
}

// The other half of the pattern: the tail a fake harness ends with, as source
// for a spawnable stub. `holdFile` keeps the stub ALIVE until that file exists
// (the test creates it when it is ready for the run to end), with a 30s
// backstop so a failed test never leaks a process. Holding the child is how a
// test proves ORDERING — dispatch returned while the run was still going,
// which the run record being non-terminal at return time demonstrates — with
// no wall-clock bound for a loaded box to flip. Without a `holdFile` this is
// the plain `delayMs` exit the stubs have always had.
function stubExitTail({ holdFile = null, exitCode = 0, delayMs = 0 } = {}) {
  if (!holdFile) return `setTimeout(() => process.exit(${exitCode}), ${delayMs});`;
  return `
{
  const holdFile = ${JSON.stringify(holdFile)};
  const deadline = Date.now() + 30000;
  const poll = () => {
    if (fs.existsSync(holdFile) || Date.now() > deadline) process.exit(${exitCode});
    setTimeout(poll, 25);
  };
  poll();
}`.trim();
}

module.exports = { waitFor, waitForFile, awaitJson, awaitRecord, stubExitTail };
