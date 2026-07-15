// capture-health — the llm-calls journal scan behind doctor's pipeline
// section and session-start's FAILING nudge
// (task-spor-distill-nudge-health-diagnostics).
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { captureHealth, failingPipelines } = require("../scripts/engines/capture-health");
const u = require("../scripts/engines/util");

const NOW = new Date("2026-07-04T12:00:00");

function scratch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-capture-health-"));
  fs.mkdirSync(path.join(home, "journal", "llm-calls"), { recursive: true });
  return home;
}

function dayFile(home, daysAgo) {
  const d = new Date(NOW.getTime() - daysAgo * 86400000);
  return path.join(home, "journal", "llm-calls", `${u.localDate(d)}.jsonl`);
}

function record({ source, error = null, ts = "2026-07-01T00:00:00.000Z" }) {
  return JSON.stringify({ id: "llm-x", ts, source, error }) + "\n";
}

test("captureHealth: counts attempts/failures per pipeline inside the window only", () => {
  const home = scratch();
  fs.writeFileSync(
    dayFile(home, 1),
    record({ source: "distill-remote", error: "distill cmd failed" }) +
      record({ source: "distill-local" }) +
      record({ source: "nudge" })
  );
  fs.writeFileSync(dayFile(home, 3), record({ source: "nudge", error: "claude -p failed" }));
  // outside the 7d window — must not count
  fs.writeFileSync(dayFile(home, 9), record({ source: "distill-remote", error: "distill cmd failed" }));

  const h = captureHealth(home, { now: NOW });
  assert.strictEqual(h.distill.attempts, 2);
  assert.strictEqual(h.distill.failures, 1);
  assert.strictEqual(h.distill.lastErr, "distill cmd failed");
  assert.strictEqual(h.nudge.attempts, 2);
  assert.strictEqual(h.nudge.failures, 1);
  assert.deepStrictEqual(failingPipelines(h), [], "partial failure is not the alarm condition");
});

test("captureHealth: a 100%-failure streak with enough attempts is FAILING", () => {
  const home = scratch();
  fs.writeFileSync(
    dayFile(home, 0),
    record({ source: "distill-remote", error: "distill cmd failed" }).repeat(3) + record({ source: "nudge" })
  );
  const h = captureHealth(home, { now: NOW });
  assert.deepStrictEqual(failingPipelines(h), ["distill"]);
});

test("captureHealth: digest-intent classifier calls count toward the digest pipeline", () => {
  const home = scratch();
  fs.writeFileSync(
    dayFile(home, 0),
    record({ source: "digest-intent", error: "digest-intent cmd failed" }).repeat(3) +
      record({ source: "digest-intent" })
  );
  const h = captureHealth(home, { now: NOW });
  assert.strictEqual(h.digest.attempts, 4);
  assert.strictEqual(h.digest.failures, 3);
  assert.deepStrictEqual(failingPipelines(h), [], "3/4 failed is not a 100% streak");
});

test("captureHealth: a 100%-failure digest-intent streak alarms same as distill/nudge", () => {
  const home = scratch();
  fs.writeFileSync(dayFile(home, 0), record({ source: "digest-intent", error: "digest-intent cmd failed" }).repeat(3));
  const h = captureHealth(home, { now: NOW });
  assert.deepStrictEqual(failingPipelines(h), ["digest"]);
});

test("captureHealth: under MIN_ATTEMPTS all-failed is idle-ish, not FAILING", () => {
  const home = scratch();
  fs.writeFileSync(dayFile(home, 0), record({ source: "nudge", error: "nudge cmd failed" }).repeat(2));
  const h = captureHealth(home, { now: NOW });
  assert.strictEqual(h.nudge.failures, 2);
  assert.deepStrictEqual(failingPipelines(h), [], "2 attempts is below the alarm floor");
});

test("captureHealth: missing dir, blank lines, and junk lines never throw", () => {
  const home = scratch();
  fs.rmSync(path.join(home, "journal", "llm-calls"), { recursive: true });
  assert.deepStrictEqual(failingPipelines(captureHealth(home, { now: NOW })), []);

  fs.mkdirSync(path.join(home, "journal", "llm-calls"), { recursive: true });
  fs.writeFileSync(dayFile(home, 0), "\nnot json\n" + record({ source: "other-source" }));
  const h = captureHealth(home, { now: NOW });
  assert.strictEqual(h.distill.attempts + h.nudge.attempts, 0, "junk and unknown sources are skipped");
});

test("captureHealth: lastOkTs tracks the newest success", () => {
  const home = scratch();
  fs.writeFileSync(
    dayFile(home, 2),
    record({ source: "distill-remote", ts: "2026-07-02T01:00:00.000Z" }) +
      record({ source: "distill-remote", ts: "2026-07-02T09:00:00.000Z" }) +
      record({ source: "distill-remote", error: "x", ts: "2026-07-02T10:00:00.000Z" })
  );
  const h = captureHealth(home, { now: NOW });
  assert.strictEqual(h.distill.lastOkTs, "2026-07-02T09:00:00.000Z");
});

test("captureHealth: an oversized day file is tail-bounded, drops only the cut head line", () => {
  const home = scratch();
  // ~2.5MB of failures, then 3 successes at the end: the head is cut, the
  // tail parses, and no partial line poisons the scan.
  const fail = record({ source: "nudge", error: "nudge cmd failed" });
  const chunk = fail.repeat(Math.ceil((2.5 * 1024 * 1024) / fail.length));
  fs.writeFileSync(dayFile(home, 0), chunk + record({ source: "nudge" }).repeat(3));
  const h = captureHealth(home, { now: NOW });
  assert.ok(h.nudge.attempts > 1000, "the bounded tail still covers plenty of records");
  assert.ok(h.nudge.failures < h.nudge.attempts, "the trailing successes are seen");
  assert.deepStrictEqual(failingPipelines(h), []);
});
