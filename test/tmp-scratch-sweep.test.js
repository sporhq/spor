// tmp-scratch-sweep.test.js — the killed-run scratch sweep in
// test/helpers/tmp-cleanup.js (issue-spor-test-scratch-leaks-on-killed-runs).
//
// tmp-cleanup.js's own exit handler only fires on a normal exit; a run killed
// by a timeout/SIGKILL leaves its scratch dirs behind forever. sweepStaleScratch()
// is the self-healing half: it runs at the START of the next process (see the
// install block below) and removes only its own dead-pid, stale-mtime dirs —
// never a dir with no marker, and never a live pid's, ours or a concurrent
// agent's sharing the same /tmp.
//
// Every fixture below lives under ROOT, our own throwaway scratch container,
// and every sweepStaleScratch() call is pointed explicitly at it — never at
// the ambient default (the real, shared os.tmpdir()), so this file can never
// inspect or touch another agent's live run sharing this same box's /tmp.
//
// A "dead pid" here is a real one: we spawn a short-lived child and use its
// pid once spawnSync has returned (i.e. once it has already exited) — no
// sleep, no guessing an unused pid number.

require("./helpers/tmp-cleanup"); // scratch-dir leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { sweepStaleScratch, isPidAlive, SCRATCH_NAME_RE } = require("./helpers/tmp-cleanup.js");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tmp-scratch-sweep-test-root-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const ONE_HOUR_MS = 60 * 60 * 1000;

function deadPid() {
  const r = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.ok(Number.isInteger(r.pid) && r.pid > 0, "spawnSync returns the child's pid");
  assert.equal(isPidAlive(r.pid), false, "a completed spawnSync child is already dead");
  return r.pid;
}

// Builds a dir matching SCRATCH_NAME_RE by hand (mimicking what the wrapped
// fs.mkdtempSync would have produced) under ROOT, and backdates its mtime, so
// the test controls staleness directly instead of waiting on a real clock.
function makeMarkedDir(pid, { ageMs }) {
  const name = `sweep-test-spor-scratch-${pid}-abc123`;
  const full = path.join(ROOT, name);
  fs.mkdirSync(full);
  const past = new Date(Date.now() - ageMs);
  fs.utimesSync(full, past, past);
  return full;
}

test("sweepStaleScratch: removes a dead-pid, stale-mtime marked dir", () => {
  const pid = deadPid();
  const dir = makeMarkedDir(pid, { ageMs: 3 * ONE_HOUR_MS });
  assert.match(path.basename(dir), SCRATCH_NAME_RE, "fixture matches the sweep's own naming convention");
  try {
    sweepStaleScratch(ONE_HOUR_MS, ROOT);
    assert.equal(fs.existsSync(dir), false, "a dead-pid dir older than maxAgeMs is removed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepStaleScratch: never removes a live-pid dir, however old its mtime", () => {
  const dir = makeMarkedDir(process.pid, { ageMs: 3 * ONE_HOUR_MS });
  try {
    sweepStaleScratch(ONE_HOUR_MS, ROOT);
    assert.equal(fs.existsSync(dir), true, "this process's own pid is alive — its dir is left alone");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepStaleScratch: never removes a dead-pid dir that isn't stale yet", () => {
  const pid = deadPid();
  const dir = makeMarkedDir(pid, { ageMs: 1000 });
  try {
    sweepStaleScratch(ONE_HOUR_MS, ROOT);
    assert.equal(fs.existsSync(dir), true, "too recent to be a killed run's leftover yet — left alone");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepStaleScratch: never touches a dir with no encoded-pid marker, dead-looking name or not", () => {
  const pid = deadPid();
  const full = path.join(ROOT, `unrelated-tool-${pid}-scratch`);
  fs.mkdirSync(full);
  const past = new Date(Date.now() - 3 * ONE_HOUR_MS);
  fs.utimesSync(full, past, past);
  try {
    sweepStaleScratch(ONE_HOUR_MS, ROOT);
    assert.equal(fs.existsSync(full), true, "no SCRATCH_NAME_RE marker — never inspected, let alone removed");
  } finally {
    fs.rmSync(full, { recursive: true, force: true });
  }
});

test("fs.mkdtempSync: the returned dir's name carries this process's live pid", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-pid-marker-test-"));
  try {
    const m = SCRATCH_NAME_RE.exec(path.basename(dir));
    assert.ok(m, "mkdtempSync's wrap injects the marker into every dir it creates under the temp root");
    assert.equal(Number(m[1]), process.pid, "the encoded pid is this process's own");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isPidAlive: false for a completed child, true for this process itself", () => {
  assert.equal(isPidAlive(deadPid()), false);
  assert.equal(isPidAlive(process.pid), true);
});
