// Durable terminal records for dispatched runs
// (inc-spor-dispatch-session-vanished-2026-07-18). A `native-background` launch
// hands the child to the harness daemon and returns, so the launcher never sees
// it exit and `claude agents --json` lists only what is still LIVE — before this
// a finished run and a dead one were indistinguishable afterwards. Every case
// below must leave a queryable terminal record, or an explicit refusal.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const runner = require("../lib/shell/agent-dispatch-runner.js");
const { writeSpawnableNodeStub, pathWithOnlyGit } = require("./helpers/portable");

// Isolated env: no SPOR_*/SUBSTRATE_* leakage, local mode, and a scratch
// CLAUDE_CONFIG_DIR so transcript lookup never touches the real ~/.claude.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-runs-iso-"));
function bare(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME" || k === "CLAUDE_CONFIG_DIR") continue;
    env[k] = v;
  }
  env.SPOR_HOME = ISO_HOME;
  env.XDG_CONFIG_HOME = ISO_HOME;
  env.SPOR_FAKE_AGENTS_JSON = "[]";
  return Object.assign(env, extra);
}
function cli(args, env, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: bare(env), cwd });
}

function scratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A graph home with one dispatchable node under repo `demo`.
function fixture() {
  const home = scratch("spor-runs-home-");
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(
    path.join(nodes, "dec-x.md"),
    `---\nid: dec-x\ntype: decision\nrepo: demo\ntitle: A demo decision about auth token rotation\nsummary: A demo decision describing auth token rotation and credential handling for the pipeline.\ndate: 2026-06-01\n---\nBody about auth token rotation and credential handling.\n`
  );
  const base = scratch("spor-runs-repo-");
  const repo = path.join(base, "demo");
  fs.mkdirSync(repo);
  return { home, repo };
}

function runRecords(home) {
  return runner.readRunRecords(home);
}

// A pid that is genuinely gone: spawnSync returns only after the child has been
// waited for, so this is a dead AND reaped pid, not a zombie that still answers
// a liveness probe.
function deadPid() {
  return spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid;
}

// A genuinely long-lived process to stand in for an un-detached harness child
// left running after its supervisor is gone (issue-spor-dispatch-vanished-
// supervisor-orphan-child). Callers are responsible for making sure it ends
// up dead one way or another.
function liveChild() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

async function waitUntilDead(pid, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!runner.pidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !runner.pidAlive(pid);
}

// A supervised record as `launchSupervisedHarness` leaves it, aged past the
// registration grace window.
function supervisedRecord(home, runId, extra = {}) {
  const p = runner.runPaths(home, runId);
  const record = {
    run_id: runId,
    node_id: `issue-${runId}`,
    harness: "codex",
    launch_mode: "supervised-jsonl",
    state: "running",
    cwd: "/tmp/spor-runs-supervised",
    created_at: "2026-07-18T10:00:00.000Z",
    log_path: p.log,
    report_path: p.report,
    ...extra,
  };
  runner.atomicJson(p.record, record);
  return record;
}

// One JSONL transcript under a scratch CLAUDE_CONFIG_DIR, at the path the
// harness itself uses: projects/<cwd with non-alphanumerics dashed>/<sid>.jsonl.
function writeTranscript(configDir, cwd, sessionId, lines) {
  const dir = path.join(configDir, "projects", String(cwd).replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

const TOOL_RESULT = { type: "user", timestamp: "2026-07-18T09:59:59.638Z", message: { role: "user", content: [{ type: "tool_result", content: "Exit code 2", is_error: true }] } };
const CLEAN_END = { type: "system", subtype: "turn_duration", durationMs: 159575, timestamp: "2026-07-18T10:25:37.180Z" };
const BOOKKEEPING = { type: "last-prompt", lastPrompt: "You are a delegated implementation agent." };

// --- classification (pure) -------------------------------------------------

test("classifyTerminalText: provider credit exhaustion is an ENVIRONMENT failure with its reason retained", () => {
  const c = runner.classifyTerminalText("thinking…\nError: your account is out of usage credits\n");
  assert.strictEqual(c.class, "environment");
  assert.strictEqual(c.signal, "credit-exhausted");
  assert.match(c.reason, /out of usage credits/);
});

test("classifyTerminalText: usage limits, rate limits and rejected auth are environment; ordinary failure is not", () => {
  assert.strictEqual(runner.classifyTerminalText("Claude AI usage limit reached").class, "environment");
  assert.strictEqual(runner.classifyTerminalText('{"type":"error","error":{"type":"rate_limit_error"}}').signal, "rate-limited");
  assert.strictEqual(runner.classifyTerminalText("authentication_error: invalid x-api-key").signal, "auth-rejected");
  // A product failure must NOT be laundered into "environment" — that is the
  // conflation this incident forbids.
  assert.strictEqual(runner.classifyTerminalText("npm test failed: 3 assertions"), null);
  assert.strictEqual(runner.classifyTerminalText(""), null);
});

test("transcriptOutcome: a mid-turn stop is 'vanished' and names the last record; a clean turn is 'done'", () => {
  const vanished = runner.transcriptOutcome([JSON.stringify({ type: "assistant" }), JSON.stringify(TOOL_RESULT), JSON.stringify(BOOKKEEPING)].join("\n"));
  assert.strictEqual(vanished.state, "vanished");
  assert.strictEqual(vanished.termination_signal, "mid-turn");
  assert.match(vanished.termination_reason, /stops mid-turn after a 'user' record at 2026-07-18T09:59:59\.638Z/);

  const done = runner.transcriptOutcome([JSON.stringify(TOOL_RESULT), JSON.stringify(CLEAN_END), JSON.stringify(BOOKKEEPING)].join("\n"));
  assert.strictEqual(done.state, "done");
  assert.strictEqual(done.termination_class, "completed");
});

test("transcriptOutcome: a session that completed EARLIER turns and then died mid-turn is still vanished", () => {
  // Every turn ends with a marker, so only the trailing records say how the
  // SESSION stopped — reading the whole tail would call this a clean finish.
  const text = [
    JSON.stringify({ type: "assistant", timestamp: "2026-07-18T09:00:00Z" }),
    JSON.stringify(CLEAN_END),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-18T09:58:00Z" }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-18T09:59:00Z" }),
    JSON.stringify(TOOL_RESULT),
  ].join("\n");
  const o = runner.transcriptOutcome(text);
  assert.strictEqual(o.state, "vanished");
  assert.strictEqual(o.termination_signal, "mid-turn");
});

test("transcriptOutcome: session bookkeeping written AFTER the final turn does not fake a vanish", () => {
  // The harness appends metadata records freely once the turn is over. These
  // are the real trailing types seen on the dev box (queue-operation and
  // pr-link even carry timestamps, so "has a timestamp" cannot separate them);
  // before the turn-record allowlist they pushed the end-of-turn marker out of
  // the trailing window and reported 52 cleanly-finished sessions as vanished.
  const text = [
    JSON.stringify({ type: "assistant", timestamp: "2026-07-18T10:25:00Z" }),
    JSON.stringify({ type: "system", subtype: "stop_hook_summary", timestamp: "2026-07-18T10:25:36Z" }),
    JSON.stringify(CLEAN_END),
    JSON.stringify({ type: "queue-operation", timestamp: "2026-07-18T10:25:38Z", operation: "drain" }),
    JSON.stringify({ type: "bridge-session" }),
    JSON.stringify({ type: "ai-title", title: "some session" }),
    JSON.stringify({ type: "mode", mode: "default" }),
    JSON.stringify({ type: "permission-mode", permissionMode: "bypassPermissions" }),
    JSON.stringify({ type: "pr-link", timestamp: "2026-07-18T10:25:40Z", url: "https://example.invalid/pr/1" }),
  ].join("\n");
  const o = runner.transcriptOutcome(text);
  assert.strictEqual(o.state, "done");
  assert.strictEqual(o.termination_class, "completed");
});

test("transcriptOutcome: a NEW turn that starts after a clean one and never answers is still vanished", () => {
  // The counterpart guard: user input after the marker is a turn that genuinely
  // began and never finished, so the allowlist must not launder it into 'done'.
  const text = [
    JSON.stringify({ type: "assistant", timestamp: "2026-07-18T10:25:00Z" }),
    JSON.stringify(CLEAN_END),
    JSON.stringify({ type: "user", timestamp: "2026-07-18T10:30:00Z", message: { role: "user", content: "one more thing" } }),
    JSON.stringify({ type: "attachment", timestamp: "2026-07-18T10:30:01Z" }),
  ].join("\n");
  const o = runner.transcriptOutcome(text);
  assert.strictEqual(o.state, "vanished");
  assert.strictEqual(o.termination_signal, "mid-turn");
});

test("transcriptOutcome: a transcript of pure bookkeeping has no turn state to read", () => {
  const text = [
    JSON.stringify({ type: "custom-title", title: "x" }),
    JSON.stringify({ type: "agent-name", name: "y" }),
    JSON.stringify({ type: "permission-mode", permissionMode: "default" }),
  ].join("\n");
  const o = runner.transcriptOutcome(text);
  assert.strictEqual(o.state, "vanished");
  assert.strictEqual(o.termination_signal, "empty-transcript");
});

test("transcriptOutcome: an agent that merely DISCUSSED credit exhaustion and finished cleanly is not an environment failure", () => {
  const text = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "the Fable run died: out of usage credits" }] } }),
    JSON.stringify(CLEAN_END),
  ].join("\n");
  assert.strictEqual(runner.transcriptOutcome(text).termination_class, "completed");
});

test("transcriptOutcome: a credit death at the tail of an unfinished turn IS classified environment", () => {
  const text = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }),
    JSON.stringify({ type: "system", subtype: "error", timestamp: "2026-07-18T10:00:00Z", content: "out of usage credits" }),
  ].join("\n");
  const o = runner.transcriptOutcome(text);
  assert.strictEqual(o.state, "failed");
  assert.strictEqual(o.termination_class, "environment");
  assert.match(o.termination_reason, /out of usage credits/);
});

test("transcriptOutcome: an unreadable/empty transcript still yields a terminal record, never silence", () => {
  const o = runner.transcriptOutcome("");
  assert.strictEqual(o.state, "vanished");
  assert.strictEqual(o.termination_signal, "empty-transcript");
  assert.ok(o.termination_reason);
});

// --- liveness + finalization ----------------------------------------------

test("isRunLive: matches a bound session by id, an unbound one by launch NAME, and rejects a pre-launch agent", () => {
  const bound = { session_id: "s1", cwd: "/w", created_at: "2026-07-18T10:00:00.000Z" };
  assert.ok(runner.isRunLive(bound, [{ sessionId: "s1", cwd: "/other" }]));
  assert.ok(!runner.isRunLive(bound, [{ sessionId: "s2", cwd: "/w" }]));
  const unbound = { name: "task-a", cwd: "/w", created_at: "2026-07-18T10:00:00.000Z" };
  assert.ok(runner.isRunLive(unbound, [{ name: "task-a", cwd: "/w", startedAt: Date.parse("2026-07-18T10:00:05.000Z") }]));
  assert.ok(!runner.isRunLive(unbound, [{ name: "task-a", cwd: "/w", startedAt: Date.parse("2026-07-18T09:00:00.000Z") }]));
  assert.ok(!runner.isRunLive(unbound, [{ name: "task-a", cwd: "/elsewhere", startedAt: Date.parse("2026-07-18T10:00:05.000Z") }]));
  assert.ok(!runner.isRunLive(unbound, []));
});

test("isRunLive: a SIBLING agent sharing the checkout never holds an unbound run open", () => {
  // issue-spor-dispatch-run-liveness-same-cwd-misattribution: two `--no-worktree`
  // dispatches into one repo share a cwd, so co-location is not evidence about
  // THIS run. task-a is dead; task-b is very much alive in the same directory.
  const dead = { name: "task-a", cwd: "/repo", created_at: "2026-07-18T10:00:00.000Z" };
  const sibling = { name: "task-b", cwd: "/repo", sessionId: "s-b", startedAt: Date.parse("2026-07-18T10:00:05.000Z") };
  assert.ok(!runner.isRunLive(dead, [sibling]), "a sibling in the same checkout is not this run");
  // …and the sibling's own record is still correctly live.
  assert.ok(runner.isRunLive({ name: "task-b", cwd: "/repo", created_at: "2026-07-18T10:00:00.000Z" }, [sibling]));
});

test("isRunLive: a run with no identity at all is never inferred alive from co-location", () => {
  const anonymous = { cwd: "/repo", created_at: "2026-07-18T10:00:00.000Z" };
  assert.ok(!runner.isRunLive(anonymous, [{ name: "task-b", cwd: "/repo", startedAt: Date.parse("2026-07-18T10:00:05.000Z") }]));
});

test("isRunLive: RE-DISPATCHING the same node into the same checkout never keeps the prior unbound run alive", () => {
  // issue-spor-dispatch-unbound-run-identity-not-unique: a launch NAME is
  // derived from the node id, so it is REUSED across re-dispatches — unlike a
  // session id it is not unique. dead-run's own agent vanished long ago; a
  // LATER re-dispatch of the SAME node (same name, same cwd) is now live. The
  // later agent must never be read as evidence that the EARLIER run is alive.
  const first = { name: "issue-x", cwd: "/repo", created_at: "2026-07-18T10:00:00.000Z" };
  const second = { name: "issue-x", cwd: "/repo", created_at: "2026-07-18T10:15:00.000Z" };
  const laterAgent = { name: "issue-x", cwd: "/repo", startedAt: Date.parse("2026-07-18T10:15:03.000Z") };
  assert.ok(!runner.isRunLive(first, [laterAgent]), "the earlier, dead run is not resurrected by a later same-named agent");
  assert.ok(runner.isRunLive(second, [laterAgent]), "…while the run that agent actually belongs to reads live");
});

test("finalizeRun: a live run, an already-terminal run, and a run inside its grace window are left alone", () => {
  const now = () => "2026-07-18T10:00:30.000Z";
  const rec = { state: "running", cwd: "/w", created_at: "2026-07-18T10:00:00.000Z" };
  assert.strictEqual(runner.finalizeRun(rec, { alive: true, now }), null);
  assert.strictEqual(runner.finalizeRun({ ...rec, state: "done" }, { alive: false, now }), null);
  assert.strictEqual(runner.finalizeRun(rec, { alive: false, now }), null, "30s in: still registering, not vanished");
});

test("finalizeRun: a child that exited BEFORE session binding is terminal, and says exactly that", () => {
  const configDir = scratch("spor-runs-cc-");
  const patch = runner.finalizeRun(
    { state: "running", cwd: path.join(configDir, "nowhere"), created_at: "2026-07-18T10:00:00.000Z" },
    { alive: false, env: { CLAUDE_CONFIG_DIR: configDir }, now: () => "2026-07-18T10:10:00.000Z" }
  );
  assert.strictEqual(patch.state, "vanished");
  assert.strictEqual(patch.termination_signal, "session-unbound");
  assert.match(patch.termination_reason, /never bound a session/);
  assert.ok(patch.finished_at, "a terminal record always carries when it ended");
});

test("finalizeRun: a BOUND run is resolved from its own transcript, named by its session id", () => {
  const configDir = scratch("spor-runs-cc-");
  const cwd = "/tmp/spor-runs-demo";
  const file = writeTranscript(configDir, cwd, "sid-late", [TOOL_RESULT, CLEAN_END]);
  const patch = runner.finalizeRun(
    { state: "running", cwd, session_id: "sid-late", created_at: "2026-07-18T10:00:00.000Z" },
    { alive: false, env: { CLAUDE_CONFIG_DIR: configDir }, now: () => "2026-07-18T10:10:00.000Z" }
  );
  assert.strictEqual(patch.state, "done");
  assert.strictEqual(patch.transcript_path, file, "the record points at the transcript it was read from");
});

test("finalizeRun: an unbound run NEVER borrows a transcript from its checkout", () => {
  // issue-spor-dispatch-run-liveness-same-cwd-misattribution, harm 2: a project
  // dir is one CHECKOUT. This transcript belongs to whoever else ran here — it
  // postdates the launch and would have been adopted as newest-in-dir. A record
  // that confidently points at the wrong transcript is worse than no record.
  const configDir = scratch("spor-runs-cc-");
  const cwd = "/tmp/spor-runs-shared";
  writeTranscript(configDir, cwd, "sid-of-a-different-run", [TOOL_RESULT, CLEAN_END]);
  const patch = runner.finalizeRun(
    { state: "running", name: "task-a", cwd, created_at: "2026-07-18T10:00:00.000Z" },
    { alive: false, env: { CLAUDE_CONFIG_DIR: configDir }, now: () => "2026-07-18T10:10:00.000Z" }
  );
  assert.strictEqual(patch.state, "vanished", "it is terminal — never left hanging");
  assert.strictEqual(patch.termination_signal, "session-unbound");
  assert.ok(!patch.transcript_path, "no transcript is attributed without identity");
  assert.match(patch.termination_reason, /how it ended is unknown/);
});

test("finalizeRun: a bound run whose transcript is missing says so, and does not fall back to a sibling's", () => {
  const configDir = scratch("spor-runs-cc-");
  const cwd = "/tmp/spor-runs-gone";
  writeTranscript(configDir, cwd, "sid-of-a-different-run", [TOOL_RESULT, CLEAN_END]);
  const patch = runner.finalizeRun(
    { state: "running", cwd, session_id: "sid-mine", created_at: "2026-07-18T10:00:00.000Z" },
    { alive: false, env: { CLAUDE_CONFIG_DIR: configDir }, now: () => "2026-07-18T10:10:00.000Z" }
  );
  assert.strictEqual(patch.termination_signal, "no-transcript");
  assert.ok(!patch.transcript_path);
  assert.match(patch.termination_reason, /sid-mine/);
});

// --- reconciliation over the record store ---------------------------------

test("reconcileRuns: resolves dead native runs, keeps live ones, and leaves a live supervisor's run alone", () => {
  const home = scratch("spor-runs-store-");
  const configDir = scratch("spor-runs-cc-");
  const cwd = "/tmp/spor-runs-recon";
  writeTranscript(configDir, cwd, "sid-dead", [TOOL_RESULT]);
  const dead = runner.beginNativeRun(home, { harness: "claude-code", name: "n-dead", nodeId: "issue-dead", cwd, now: () => "2026-07-18T10:00:00.000Z" });
  runner.updateRun(dead, { state: "running", session_id: "sid-dead" });
  const live = runner.beginNativeRun(home, { harness: "claude-code", name: "n-live", nodeId: "issue-live", cwd, now: () => "2026-07-18T10:00:00.000Z" });
  runner.updateRun(live, { state: "running", session_id: "sid-live" });
  // A supervised record whose supervisor is still up: its own runner owns
  // finalization, so reconciliation must leave it exactly as found. Its liveness
  // is its supervisor's pid, never the native agent list — which is empty of it.
  runner.atomicJson(runner.runPaths(home, "sup-1").record, { run_id: "sup-1", harness: "codex", launch_mode: "supervised-jsonl", state: "running", runner_pid: process.pid, created_at: "2026-07-18T10:00:00.000Z" });

  const out = runner.reconcileRuns(home, {
    agents: [{ sessionId: "sid-live", cwd, kind: "background" }],
    env: { CLAUDE_CONFIG_DIR: configDir },
    now: () => "2026-07-18T10:10:00.000Z",
  });
  const byId = new Map(out.map((r) => [r.run_id, r]));
  assert.strictEqual(byId.get(dead.runId).state, "vanished");
  assert.strictEqual(byId.get(dead.runId).termination_signal, "mid-turn");
  assert.strictEqual(byId.get(live.runId).state, "running");
  assert.strictEqual(byId.get("sup-1").state, "running");
  // Durable: the derived outcome is written back, not just returned.
  assert.strictEqual(runRecords(home).find((r) => r.run_id === dead.runId).state, "vanished");
  assert.strictEqual(runRecords(home).find((r) => r.run_id === "sup-1").state, "running", "a healthy supervised run is never prematurely finalized");
});

test("reconcileRuns: two concurrent dispatches in ONE checkout resolve independently", () => {
  // The `--no-worktree` shape from issue-spor-dispatch-run-liveness-same-cwd-
  // misattribution: both runs share a cwd and neither bound a session. The dead
  // one must reach a terminal state even though its sibling is alive beside it,
  // and it must not be handed the sibling's transcript as its evidence.
  const home = scratch("spor-runs-store-");
  const configDir = scratch("spor-runs-cc-");
  const cwd = "/tmp/spor-runs-shared-checkout";
  // The only transcript here belongs to the LIVE sibling.
  const siblingTranscript = writeTranscript(configDir, cwd, "sid-live-sibling", [TOOL_RESULT, CLEAN_END]);
  const dead = runner.beginNativeRun(home, { harness: "claude-code", name: "issue-dead", nodeId: "issue-dead", cwd, now: () => "2026-07-18T10:00:00.000Z" });
  runner.updateRun(dead, { state: "running" });
  const live = runner.beginNativeRun(home, { harness: "claude-code", name: "issue-live", nodeId: "issue-live", cwd, now: () => "2026-07-18T10:00:00.000Z" });
  runner.updateRun(live, { state: "running" });

  const out = runner.reconcileRuns(home, {
    agents: [{ name: "issue-live", cwd, kind: "background", startedAt: Date.parse("2026-07-18T10:00:05.000Z") }],
    env: { CLAUDE_CONFIG_DIR: configDir },
    now: () => "2026-07-18T10:10:00.000Z",
  });
  const byId = new Map(out.map((r) => [r.run_id, r]));
  assert.strictEqual(byId.get(live.runId).state, "running", "the live sibling is still live");
  const d = byId.get(dead.runId);
  assert.ok(runner.TERMINAL_STATES.has(d.state), "the dead run reaches a terminal state regardless of its sibling");
  assert.strictEqual(d.termination_signal, "session-unbound");
  assert.notStrictEqual(d.transcript_path, siblingTranscript, "and is never handed the sibling's transcript");
  assert.ok(!d.transcript_path);
});

test("reconcileRuns: RE-DISPATCHING the same node into the same checkout never keeps the prior unbound run alive", () => {
  // issue-spor-dispatch-unbound-run-identity-not-unique: unlike the "two
  // concurrent dispatches" case above (different names), a re-dispatch of the
  // SAME node into the SAME checkout launches an agent under the SAME launch
  // name (cmdDispatch derives it from the node id). The first run's session
  // never bound and its agent is long gone by the time the second launches;
  // the second run's own live agent must not be read as the first run's
  // evidence of life just because it shares that name and cwd.
  const home = scratch("spor-runs-store-");
  const configDir = scratch("spor-runs-cc-");
  const cwd = "/tmp/spor-runs-redispatch";
  const secondTranscript = writeTranscript(configDir, cwd, "sid-second-run", [TOOL_RESULT, CLEAN_END]);
  const first = runner.beginNativeRun(home, { harness: "claude-code", name: "issue-x", nodeId: "issue-x", cwd, now: () => "2026-07-18T10:00:00.000Z" });
  runner.updateRun(first, { state: "running" });
  const second = runner.beginNativeRun(home, { harness: "claude-code", name: "issue-x", nodeId: "issue-x", cwd, now: () => "2026-07-18T10:20:00.000Z" });
  runner.updateRun(second, { state: "running", session_id: "sid-second-run" });

  const out = runner.reconcileRuns(home, {
    agents: [{ sessionId: "sid-second-run", name: "issue-x", cwd, kind: "background", startedAt: Date.parse("2026-07-18T10:20:05.000Z") }],
    env: { CLAUDE_CONFIG_DIR: configDir },
    now: () => "2026-07-18T10:30:00.000Z",
  });
  const byId = new Map(out.map((r) => [r.run_id, r]));
  assert.strictEqual(byId.get(second.runId).state, "running", "the re-dispatched (later) run is still live");
  const f = byId.get(first.runId);
  assert.ok(runner.TERMINAL_STATES.has(f.state), "the earlier run reaches a terminal state despite sharing name+cwd with the later one");
  assert.strictEqual(f.termination_signal, "session-unbound");
  assert.notStrictEqual(f.transcript_path, secondTranscript, "and is never handed the later run's transcript");
  assert.ok(!f.transcript_path);
});

test("reconcileRuns: a QUICK re-dispatch, both still unbound, does not let the older run borrow the newer one's liveness", () => {
  // issue-spor-dispatch-unbound-run-identity-not-unique: the grace window that
  // covers the harness's own registration lag is symmetric around EACH
  // record's created_at, so a re-dispatch only 15s later — well INSIDE that
  // window on both sides — would otherwise satisfy the OLDER record's
  // identity test too, from the SAME live agent. Unlike the original
  // unbounded bug this wouldn't even self-correct with time: created_at and
  // startedAt are fixed, so the older record would stay wrongly non-terminal
  // for as long as the newer run's own agent keeps running. Only the more
  // recently launched record may claim a shared name+cwd agent.
  const home = scratch("spor-runs-store-");
  const configDir = scratch("spor-runs-cc-");
  const cwd = "/tmp/spor-runs-quick-redispatch";
  const first = runner.beginNativeRun(home, { harness: "claude-code", name: "issue-x", nodeId: "issue-x", cwd, now: () => "2026-07-18T10:00:00.000Z" });
  runner.updateRun(first, { state: "running" });
  const second = runner.beginNativeRun(home, { harness: "claude-code", name: "issue-x", nodeId: "issue-x", cwd, now: () => "2026-07-18T10:00:15.000Z" });
  runner.updateRun(second, { state: "running" });

  const out = runner.reconcileRuns(home, {
    // Only the SECOND run's own agent is alive — but its startedAt sits
    // within the 60s grace window of BOTH records' created_at.
    agents: [{ name: "issue-x", cwd, kind: "background", startedAt: Date.parse("2026-07-18T10:00:16.000Z") }],
    env: { CLAUDE_CONFIG_DIR: configDir },
    now: () => "2026-07-18T10:05:00.000Z", // past the FIRST record's own 60s grace window
  });
  const byId = new Map(out.map((r) => [r.run_id, r]));
  assert.strictEqual(byId.get(second.runId).state, "running", "the newer run correctly reads live");
  const f = byId.get(first.runId);
  assert.ok(runner.TERMINAL_STATES.has(f.state), "the older run reaches a terminal state even though the live agent falls within ITS OWN grace window too");
  assert.strictEqual(f.termination_signal, "session-unbound");
});

test("reconcileRuns: a same-name TERMINAL or cross-harness record never outranks a genuinely-live native run for ownership of its own agent", () => {
  // The owner tie-break only needs to arbitrate between records that would
  // otherwise both consume the ownership map — a supervised-jsonl record
  // reconciles off its own pid (never off `agents`), and an already-terminal
  // record's own `finalizeRun` short-circuits before ever consulting `scoped`.
  // Neither benefits from winning a tie-break, but letting either win one
  // wrongly DENIES the shared name+cwd agent to a currently-alive native
  // record — worse than the residual same-mode ambiguity, since here there
  // was never an actual second live native dispatch to be ambiguous about.
  const home = scratch("spor-runs-store-");
  const configDir = scratch("spor-runs-cc-");
  const cwd = "/tmp/spor-runs-cross-mode-steal";
  const first = runner.beginNativeRun(home, { harness: "claude-code", name: "issue-x", nodeId: "issue-x", cwd, now: () => "2026-07-18T10:00:00.000Z" });
  runner.updateRun(first, { state: "running" });
  // A same-name, same-cwd SUPERVISED-JSONL record, created later than `first`
  // but still within the 60s grace window of the one live agent below — if it
  // were eligible to win the tie-break (later `created_at`), it would steal
  // that agent from `first` despite never itself consulting `agents` at all.
  runner.atomicJson(runner.runPaths(home, "sup-cross-1").record, {
    run_id: "sup-cross-1", node_id: "issue-x", name: "issue-x", harness: "codex",
    launch_mode: "supervised-jsonl", state: "running", cwd,
    runner_pid: 999999999, // guaranteed-dead pid — its own outcome isn't the point here
    created_at: "2026-07-18T10:00:30.000Z",
  });
  const out = runner.reconcileRuns(home, {
    // The ONLY live agent, genuinely `first`'s own: started 5s after `first`
    // was created (well within grace), and 25s before the supervised record
    // above — also well within ITS 60s grace window, which is the whole hazard.
    agents: [{ name: "issue-x", cwd, kind: "background", startedAt: Date.parse("2026-07-18T10:00:05.000Z") }],
    env: { CLAUDE_CONFIG_DIR: configDir },
    now: () => "2026-07-18T10:10:00.000Z", // past `first`'s own 60s grace window
  });
  const byId = new Map(out.map((r) => [r.run_id, r]));
  assert.strictEqual(byId.get(first.runId).state, "running", "the genuinely-live native run keeps its own agent as evidence");
});

test("reconcileRuns: a harness that could not be listed reconciles NOTHING (stale child state is not death)", () => {
  const home = scratch("spor-runs-store-");
  const rec = runner.beginNativeRun(home, { harness: "claude-code", name: "n", nodeId: "issue-x", cwd: "/tmp/nope", now: () => "2026-07-18T10:00:00.000Z" });
  runner.updateRun(rec, { state: "running" });
  const out = runner.reconcileRuns(home, { agents: [], enumerated: false, now: () => "2026-07-18T11:00:00.000Z" });
  assert.strictEqual(out[0].state, "running");
  assert.strictEqual(runRecords(home)[0].state, "running", "nothing written back");
});

// --- the supervised path (issue-spor-dispatch-supervised-runs-never-reconciled)
// A Codex dispatch is supervised by a DETACHED process of ours. When it dies
// before finalizing, nothing else ever will — so reconciliation must close the
// run from the evidence the adapter declares (its supervisor's pid and its own
// log), never from the native agent list, which knows nothing about it.

test("reconcileRuns: a supervised run whose supervisor was killed mid-run is closed, not left running", () => {
  const home = scratch("spor-runs-store-");
  supervisedRecord(home, "sup-killed", { runner_pid: deadPid() });
  const out = runner.reconcileRuns(home, { agents: [], now: () => "2026-07-18T10:10:00.000Z" });
  assert.strictEqual(out[0].state, "vanished");
  assert.strictEqual(out[0].termination_class, "unknown");
  assert.strictEqual(out[0].termination_signal, "supervisor-gone");
  assert.match(out[0].termination_reason, /never recorded an outcome/);
  assert.ok(out[0].finished_at, "and it carries when it was closed");
  assert.strictEqual(runRecords(home)[0].state, "vanished", "the outcome is durable, not just returned");
});

// --- orphaned child reaping (issue-spor-dispatch-vanished-supervisor-orphan-child) ---
// The harness child a supervised run launches is spawned WITHOUT `detached`, so
// a pid-targeted kill of just the supervisor leaves it running, unsupervised —
// reconciliation must notice via the recorded `child_pid` and end it, not just
// stamp the run vanished while the process keeps going.

test("reconcileRuns: a live orphaned child is reaped when its dead supervisor's run is stamped vanished", async () => {
  const home = scratch("spor-runs-store-");
  const child = liveChild();
  try {
    await new Promise((resolve) => child.once("spawn", resolve));
    const childTicks = runner.processStartTicks(child.pid);
    supervisedRecord(home, "sup-orphan-child", {
      runner_pid: deadPid(),
      child_pid: child.pid,
      ...(childTicks != null ? { child_started_ticks: childTicks } : {}),
    });
    assert.ok(runner.pidAlive(child.pid), "the child is genuinely alive before reconciliation");
    const out = runner.reconcileRuns(home, { agents: [], now: () => "2026-07-18T10:10:00.000Z" });
    assert.strictEqual(out[0].state, "vanished");
    assert.strictEqual(out[0].child_reaped, true);
    assert.ok(await waitUntilDead(child.pid), "the orphaned child was actually terminated, not just marked in the record");
    assert.strictEqual(runRecords(home)[0].child_reaped, true, "the reap is durable, not just returned");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already gone, that's the point */ }
  }
});

test("reconcileRuns: a supervised run whose child is ALSO already gone reports no reap (nothing to clean up)", () => {
  const home = scratch("spor-runs-store-");
  supervisedRecord(home, "sup-both-gone", { runner_pid: deadPid(), child_pid: deadPid() });
  const out = runner.reconcileRuns(home, { agents: [], now: () => "2026-07-18T10:10:00.000Z" });
  assert.strictEqual(out[0].state, "vanished");
  assert.strictEqual(out[0].child_reaped, undefined);
});

test("reconcileRuns: a recycled child_pid is never signaled — identity mismatch leaves the unrelated process alone", async () => {
  if (process.platform !== "linux") return; // processStartTicks is Linux-only (/proc)
  const home = scratch("spor-runs-store-");
  const unrelated = liveChild();
  try {
    await new Promise((resolve) => unrelated.once("spawn", resolve));
    const actualTicks = runner.processStartTicks(unrelated.pid);
    assert.ok(Number.isFinite(actualTicks));
    supervisedRecord(home, "sup-child-reused", {
      runner_pid: deadPid(),
      child_pid: unrelated.pid,
      child_started_ticks: actualTicks + 999999, // the recorded pid is not THIS process
    });
    const out = runner.reconcileRuns(home, { agents: [], now: () => "2026-07-18T10:10:00.000Z" });
    assert.strictEqual(out[0].state, "vanished");
    assert.strictEqual(out[0].child_reaped, undefined, "a pid-reuse mismatch is not evidence to kill anything");
    assert.ok(runner.pidAlive(unrelated.pid), "the unrelated process holding the recycled pid was never touched");
  } finally {
    try { unrelated.kill("SIGKILL"); } catch { /* already gone */ }
  }
});

test("reconcileRuns: a supervisor that never reported its child is a failed LAUNCH, not a vanish", () => {
  const home = scratch("spor-runs-store-");
  // Still at `launching`: the supervisor died between the record being opened
  // and the harness child starting — including the case where the supervisor
  // itself never came up and no pid was ever recorded.
  supervisedRecord(home, "sup-never", { state: "launching", runner_pid: deadPid() });
  supervisedRecord(home, "sup-nopid", { state: "launching", runner_pid: undefined });
  const out = runner.reconcileRuns(home, { agents: [], now: () => "2026-07-18T10:10:00.000Z" });
  for (const r of out) {
    assert.strictEqual(r.state, "failed_launch", r.run_id);
    assert.strictEqual(r.termination_class, "launch");
    assert.strictEqual(r.termination_signal, "supervisor-never-started");
  }
  assert.match(out.find((r) => r.run_id === "sup-never").termination_reason, /pid \d+/);
});

test("reconcileRuns: a dead supervisor's LOG supplies the reason, so a credit-dead Codex run reads as environment", () => {
  const home = scratch("spor-runs-store-");
  const rec = supervisedRecord(home, "sup-credit", { runner_pid: deadPid() });
  fs.mkdirSync(path.dirname(rec.log_path), { recursive: true });
  fs.writeFileSync(rec.log_path, [
    JSON.stringify({ type: "thread.started", thread_id: "th-1" }),
    JSON.stringify({ type: "error", message: "stream error: your credit balance is too low to continue" }),
  ].join("\n") + "\n");
  const out = runner.reconcileRuns(home, { agents: [], now: () => "2026-07-18T10:10:00.000Z" });
  assert.strictEqual(out[0].state, "failed", "a known cause is a failure, not an unexplained vanish");
  assert.strictEqual(out[0].termination_class, "environment", "not a capability or implementation failure");
  assert.strictEqual(out[0].termination_signal, "credit-exhausted");
  assert.match(out[0].termination_reason, /credit balance is too low/);
});

test("reconcileRuns: a supervised run inside the grace window, or already terminal, is left alone", () => {
  const home = scratch("spor-runs-store-");
  supervisedRecord(home, "sup-fresh", { state: "launching", created_at: "2026-07-18T10:09:30.000Z" });
  supervisedRecord(home, "sup-done", { state: "done", runner_pid: deadPid(), termination_signal: "supervised-exit" });
  const out = runner.reconcileRuns(home, { agents: [], now: () => "2026-07-18T10:10:00.000Z" });
  const byId = new Map(out.map((r) => [r.run_id, r]));
  assert.strictEqual(byId.get("sup-fresh").state, "launching", "the supervisor is still being given time to report");
  assert.strictEqual(byId.get("sup-done").termination_signal, "supervised-exit", "an observed outcome is never overwritten");
});

test("reconcileRuns: supervised runs reconcile even when the native agent listing FAILED", () => {
  // A Codex-only box has no `claude` to enumerate, and a supervised run's
  // liveness never depended on that listing — so `enumerated: false` must not
  // strand it. The native run beside it still waits for trustworthy evidence.
  const home = scratch("spor-runs-store-");
  supervisedRecord(home, "sup-orphan", { runner_pid: deadPid() });
  const native = runner.beginNativeRun(home, { harness: "claude-code", name: "n", nodeId: "issue-n", cwd: "/tmp/nope", now: () => "2026-07-18T10:00:00.000Z" });
  runner.updateRun(native, { state: "running" });
  const out = runner.reconcileRuns(home, { agents: [], enumerated: false, now: () => "2026-07-18T10:10:00.000Z" });
  const byId = new Map(out.map((r) => [r.run_id, r]));
  assert.strictEqual(byId.get("sup-orphan").state, "vanished");
  assert.strictEqual(byId.get(native.runId).state, "running", "stale native state is still not death");
});

test("reconcileRuns: a record in neither launch mode is passed through untouched", () => {
  const home = scratch("spor-runs-store-");
  runner.atomicJson(runner.runPaths(home, "sup-alien").record, {
    run_id: "sup-alien", harness: "future", launch_mode: "something-new", state: "running", created_at: "2026-07-18T10:00:00.000Z",
  });
  const out = runner.reconcileRuns(home, { agents: [], now: () => "2026-07-18T10:10:00.000Z" });
  assert.strictEqual(out[0].state, "running", "a mode whose evidence we do not know is never guessed at");
});

test("reconcileRuns: a supervisor that finalizes mid-reconcile KEEPS its observed outcome", () => {
  // The supervisor owns the record and can finalize at any instant — including
  // between this reconciler's read and its write, which is exactly when its pid
  // stops answering. An outcome the supervisor OBSERVED (with the exit code and
  // session only it saw) must never be overwritten by a derived vanish.
  const home = scratch("spor-runs-store-");
  const rec = supervisedRecord(home, "sup-race", { runner_pid: deadPid() });
  const p = runner.runPaths(home, "sup-race");
  let ticks = 0;
  const now = () => {
    // The second `now()` is the patch's finished_at — i.e. after the verdict was
    // computed from the stale read, before it is written back.
    if (++ticks === 2) runner.atomicJson(p.record, { ...rec, state: "done", exit_code: 0, session_id: "codex-thread-1", termination_signal: "supervised-exit" });
    return "2026-07-18T10:10:00.000Z";
  };
  const out = runner.reconcileRuns(home, { agents: [], now });
  assert.strictEqual(out[0].state, "done", "the observed outcome survives");
  assert.strictEqual(out[0].termination_signal, "supervised-exit");
  const onDisk = runRecords(home)[0];
  assert.strictEqual(onDisk.state, "done");
  assert.strictEqual(onDisk.session_id, "codex-thread-1", "and its evidence is not dropped");
  assert.strictEqual(onDisk.exit_code, 0);
});

test("reconcileRuns: a pid that answers but has gone SILENT for a day is read as reuse, not as life", () => {
  // A bare pid is not identity. Pid spaces recycle (32768 wide in many
  // containers), and pruneRuns only sweeps TERMINAL records — so without a
  // backstop a recycled pid holds a record `running` forever, which is the very
  // thing this issue exists to make impossible.
  const home = scratch("spor-runs-store-");
  supervisedRecord(home, "sup-reused", { runner_pid: process.pid });
  const out = runner.reconcileRuns(home, { agents: [], now: () => "2026-07-20T10:00:00.000Z" });
  assert.strictEqual(out[0].state, "vanished");
  assert.strictEqual(out[0].termination_signal, "supervisor-stale");
  assert.match(out[0].termination_reason, /written nothing for 48h/);
  // …and the same live pid on a young run is still believed.
  const fresh = scratch("spor-runs-store-");
  supervisedRecord(fresh, "sup-young", { runner_pid: process.pid });
  const kept = runner.reconcileRuns(fresh, { agents: [], now: () => "2026-07-18T10:10:00.000Z" });
  assert.strictEqual(kept[0].state, "running");
});

test("reconcileRuns: a long run STILL WRITING to its log is alive however old it is", () => {
  // The backstop must not close a legitimately long dispatch: doing so would
  // both lie in the record and drop the run out of activeRuns, releasing the
  // same-machine guard that stops a second agent launching into its worktree.
  // Freshness — not age — is what separates a working run from a recycled pid.
  const home = scratch("spor-runs-store-");
  const rec = supervisedRecord(home, "sup-longhaul", { runner_pid: process.pid });
  fs.mkdirSync(path.dirname(rec.log_path), { recursive: true });
  fs.writeFileSync(rec.log_path, JSON.stringify({ type: "item.completed" }) + "\n");
  // Two days into the run, but it wrote an hour ago.
  const anHourBefore = Date.parse("2026-07-20T09:00:00.000Z") / 1000;
  fs.utimesSync(rec.log_path, anHourBefore, anHourBefore);
  const out = runner.reconcileRuns(home, { agents: [], now: () => "2026-07-20T10:00:00.000Z" });
  assert.strictEqual(out[0].state, "running", "a run that is still producing output is never closed");
  assert.strictEqual(runner.lastActivityAt(rec), anHourBefore * 1000);
});

// --- supervisor identity (issue-spor-dispatch-supervisor-identity-stale-timeout) ---
// A silent run whose pid still answers is ambiguous evidence: it could be our
// supervisor wedged on a long network call, or the same pid reused by an
// unrelated process. Recording the kernel start-time tick count at launch
// resolves the ambiguity directly, so these tests exercise identity match and
// mismatch — the timeout heuristic above stays only as the no-evidence fallback.

test("finalizeSupervisedRun: a confirmed identity match is NEVER closed for silence, however long", () => {
  if (process.platform !== "linux") return; // processStartTicks is Linux-only (/proc)
  const startTicks = runner.processStartTicks(process.pid);
  assert.ok(Number.isFinite(startTicks), "the test process itself must yield a real tick count on this platform");
  const home = scratch("spor-runs-store-");
  supervisedRecord(home, "sup-identity-match", { runner_pid: process.pid, runner_started_ticks: startTicks });
  // Ten days of silence — far past staleMs — but identity is confirmed, so the
  // freshness ceiling never even applies.
  const out = runner.reconcileRuns(home, { agents: [], now: () => "2026-07-28T10:00:00.000Z" });
  assert.strictEqual(out[0].state, "running", "identity match overrides the silence heuristic entirely");
});

test("finalizeSupervisedRun: an identity MISMATCH closes the run immediately, no silence required", () => {
  if (process.platform !== "linux") return; // processStartTicks is Linux-only (/proc)
  const startTicks = runner.processStartTicks(process.pid);
  assert.ok(Number.isFinite(startTicks), "the test process itself must yield a real tick count on this platform");
  const home = scratch("spor-runs-store-");
  // The recorded tick count does not match this pid's ACTUAL start time — the
  // pid was reused by a different process than the one we launched.
  const rec = supervisedRecord(home, "sup-identity-mismatch", { runner_pid: process.pid, runner_started_ticks: startTicks + 999999 });
  fs.mkdirSync(path.dirname(rec.log_path), { recursive: true });
  fs.writeFileSync(rec.log_path, JSON.stringify({ type: "item.completed" }) + "\n");
  // Barely past the registration grace window, well short of staleMs.
  const out = runner.reconcileRuns(home, { agents: [], now: () => "2026-07-18T10:01:30.000Z" });
  assert.strictEqual(out[0].state, "vanished");
  assert.strictEqual(out[0].termination_signal, "supervisor-pid-reused");
  assert.match(out[0].termination_reason, /kernel start-time no longer matches/);
});

test("finalizeSupervisedRun: identity unknown (no recorded tick count) still falls back to the silence heuristic", () => {
  // An older record predating this feature, or a non-Linux host, carries no
  // `runner_started_ticks` — the pid-reuse guard must still degrade gracefully
  // to the freshness ceiling rather than believing an unreused pid forever.
  const home = scratch("spor-runs-store-");
  supervisedRecord(home, "sup-no-identity", { runner_pid: process.pid });
  const out = runner.reconcileRuns(home, { agents: [], now: () => "2026-07-20T10:00:00.000Z" });
  assert.strictEqual(out[0].state, "vanished");
  assert.strictEqual(out[0].termination_signal, "supervisor-stale");
});

test("processStartTicks: a dead pid, and a non-integer pid, both yield null", () => {
  assert.strictEqual(runner.processStartTicks(deadPid()), null);
  assert.strictEqual(runner.processStartTicks(-1), null);
  assert.strictEqual(runner.processStartTicks(0), null);
  assert.strictEqual(runner.processStartTicks(1.5), null);
});

test("finalizeSupervisedRun: only the log's TAIL is evidence — a recovered mid-run error is not the cause of death", () => {
  // An agent that hit a rate limit hours and thousands of events earlier and
  // carried on did not die of it; filing that as the reason sends a real crash
  // to the wrong triage (and a credit-dead run must still BE classified, which
  // is why the window is wider than transcriptOutcome's 5 filtered records).
  const home = scratch("spor-runs-store-");
  const rec = supervisedRecord(home, "sup-recovered", { runner_pid: deadPid() });
  fs.mkdirSync(path.dirname(rec.log_path), { recursive: true });
  fs.writeFileSync(rec.log_path, [
    JSON.stringify({ type: "error", message: "rate_limit_error — retrying" }),
    ...Array.from({ length: 40 }, (_, i) => JSON.stringify({ type: "item.completed", n: i })),
  ].join("\n") + "\n");
  const out = runner.reconcileRuns(home, { agents: [], now: () => "2026-07-18T10:10:00.000Z" });
  assert.strictEqual(out[0].state, "vanished", "an unexplained death stays unexplained");
  assert.strictEqual(out[0].termination_signal, "supervisor-gone");
  // …but a signal near the end still survives a trailing stack trace and summary.
  const dead = scratch("spor-runs-store-");
  const late = supervisedRecord(dead, "sup-late-signal", { runner_pid: deadPid() });
  fs.mkdirSync(path.dirname(late.log_path), { recursive: true });
  fs.writeFileSync(late.log_path, [
    ...Array.from({ length: 40 }, (_, i) => JSON.stringify({ type: "item.completed", n: i })),
    "stream error: your credit balance is too low",
    ...Array.from({ length: 8 }, (_, i) => `    at frame ${i} (codex.js:${i})`),
    JSON.stringify({ type: "turn.failed" }),
  ].join("\n") + "\n");
  const closed = runner.reconcileRuns(dead, { agents: [], now: () => "2026-07-18T10:10:00.000Z" });
  assert.strictEqual(closed[0].termination_signal, "credit-exhausted");
  assert.strictEqual(runner.lastLines("a\n\nb\nc\n", 2), "b\nc");
});

test("closeRun: stamps an open record and refuses to overwrite one already terminal", () => {
  const home = scratch("spor-runs-store-");
  const p = runner.runPaths(home, "sup-close");
  supervisedRecord(home, "sup-close", { state: "launching" });
  const closed = runner.closeRun(p.record, runner.launchFailure("the supervisor never came up", "supervisor-spawn-failed", () => "2026-07-18T10:00:01.000Z"));
  assert.strictEqual(closed.state, "failed_launch");
  assert.strictEqual(closed.termination_signal, "supervisor-spawn-failed");
  assert.strictEqual(closed.error, "the supervisor never came up");
  // A supervisor that finalized between the read and the write keeps its own
  // observed outcome.
  runner.closeRun(p.record, runner.launchFailure("racing loser", "supervisor-exited-early"));
  assert.strictEqual(runRecords(home)[0].termination_signal, "supervisor-spawn-failed");
  // …and a state that moved on underneath the caller invalidates its verdict: a
  // record now `running` did NOT fail to launch.
  const moved = scratch("spor-runs-store-");
  supervisedRecord(moved, "sup-moved", { state: "running" });
  const unchanged = runner.closeRun(runner.runPaths(moved, "sup-moved").record, runner.launchFailure("never came up"), "launching");
  assert.strictEqual(unchanged.state, "running");
  assert.strictEqual(runRecords(moved)[0].state, "running", "nothing was written");
  assert.strictEqual(runner.closeRun(path.join(home, "journal", "dispatch", "nope.run.json"), { state: "done" }), null);
});

test("pruneRuns: ages out terminal records only — an unresolved run is never swept", () => {
  const home = scratch("spor-runs-store-");
  const old = { run_id: "old", launch_mode: "native-background", state: "done", created_at: "2026-06-01T00:00:00.000Z", finished_at: "2026-06-01T00:10:00.000Z" };
  const openRun = { run_id: "open", launch_mode: "native-background", state: "running", created_at: "2026-06-01T00:00:00.000Z" };
  const fresh = { run_id: "fresh", launch_mode: "native-background", state: "vanished", created_at: "2026-07-18T00:00:00.000Z", finished_at: "2026-07-18T00:10:00.000Z" };
  for (const r of [old, openRun, fresh]) runner.atomicJson(runner.runPaths(home, r.run_id).record, r);
  const { removed } = runner.pruneRuns(home, { maxAgeMs: 14 * 86400000, now: () => Date.parse("2026-07-20T00:00:00.000Z") });
  assert.strictEqual(removed, 1);
  assert.deepStrictEqual(runRecords(home).map((r) => r.run_id).sort(), ["fresh", "open"]);
});

// --- the CLI surface -------------------------------------------------------

test("dispatch (native, stubbed): writes a durable run record at launch, and 'spor runs' reports it", () => {
  const { home, repo } = fixture();
  const configDir = scratch("spor-runs-cc-");
  cli(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const stub = writeSpawnableNodeStub(home, "claude-ok", "process.exit(0);");
  const d = cli(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, CLAUDE_CONFIG_DIR: configDir });
  assert.strictEqual(d.status, 0, d.stderr);
  assert.match(d.stdout, /^run: {5}[0-9a-f-]{36} \(Claude Code; 'spor runs' for its outcome\)$/m);

  const records = runRecords(home);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].state, "running");
  assert.strictEqual(records[0].node_id, "dec-x");
  assert.strictEqual(records[0].launch_mode, "native-background");
  assert.strictEqual(records[0].cwd, fs.realpathSync(repo));

  const r = cli(["runs", "--json"], { SPOR_HOME: home, CLAUDE_CONFIG_DIR: configDir });
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.count, 1);
  assert.strictEqual(parsed.runs[0].node_id, "dec-x");
});

test("spor runs: a launched agent that left no transcript ends up queryable as vanished, with a reason", () => {
  const { home, repo } = fixture();
  const configDir = scratch("spor-runs-cc-");
  cli(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const stub = writeSpawnableNodeStub(home, "claude-ok", "process.exit(0);");
  cli(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, CLAUDE_CONFIG_DIR: configDir });
  // Age the record past the registration grace window, then reconcile with an
  // empty (but successful) live-agent listing.
  const rec = runRecords(home)[0];
  runner.atomicJson(runner.runPaths(home, rec.run_id).record, { ...rec, created_at: "2026-07-18T10:00:00.000Z" });

  const r = cli(["runs"], { SPOR_HOME: home, CLAUDE_CONFIG_DIR: configDir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /vanished — unknown\/session-unbound/);
  assert.match(r.stdout, /why: {8}the run never bound a session/);
  assert.strictEqual(runRecords(home)[0].state, "vanished", "the outcome is durable, not just printed");
});

test("spor runs (text): a reaped orphaned child is legible without --json", async () => {
  const home = scratch("spor-runs-store-");
  const child = liveChild();
  try {
    await new Promise((resolve) => child.once("spawn", resolve));
    const childTicks = runner.processStartTicks(child.pid);
    supervisedRecord(home, "sup-orphan-child-text", {
      runner_pid: deadPid(),
      child_pid: child.pid,
      ...(childTicks != null ? { child_started_ticks: childTicks } : {}),
    });
    const r = cli(["runs"], { SPOR_HOME: home });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /reaped:     an orphaned harness child was terminated at reconciliation/);
    assert.ok(await waitUntilDead(child.pid), "the orphaned child was actually terminated");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already gone, that's the point */ }
  }
});

test("spor runs --json: 'reconciled' is false only when a NATIVE run was actually left unresolved", () => {
  // A Codex-only box has no `claude` to enumerate, and supervised runs never
  // needed that listing — reporting reconciled:false there would tell a caller
  // to distrust states that were in fact just resolved.
  const home = scratch("spor-runs-store-");
  supervisedRecord(home, "sup-only", { runner_pid: deadPid() });
  // Unparseable agent output is the "could not ask at all" case (enumerated: false).
  const blind = { SPOR_HOME: home, SPOR_FAKE_AGENTS_JSON: "not json" };
  const supervisedOnly = JSON.parse(cli(["runs", "--json"], blind).stdout);
  assert.strictEqual(supervisedOnly.reconciled, true, "nothing was left unresolved");
  assert.strictEqual(supervisedOnly.runs[0].state, "vanished");

  // Add a non-terminal NATIVE run: now the failed listing really does leave
  // something unresolved, and the caller must be told.
  const native = runner.beginNativeRun(home, { harness: "claude-code", name: "n", nodeId: "issue-n", cwd: "/tmp/nope", now: () => "2026-07-18T10:00:00.000Z" });
  runner.updateRun(native, { state: "running" });
  const withNative = cli(["runs", "--json"], blind);
  assert.strictEqual(JSON.parse(withNative.stdout).reconciled, false);
  assert.match(cli(["runs"], blind).stderr, /native run states may be stale/);
});

test("spor runs: an agent the harness still lists as 'done' does not hold its run open", () => {
  const { home, repo } = fixture();
  const configDir = scratch("spor-runs-cc-");
  cli(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const stub = writeSpawnableNodeStub(home, "claude-ok", "process.exit(0);");
  cli(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, CLAUDE_CONFIG_DIR: configDir });
  const rec = runRecords(home)[0];
  runner.atomicJson(runner.runPaths(home, rec.run_id).record, { ...rec, created_at: "2026-07-18T10:00:00.000Z" });
  const agents = JSON.stringify([{ kind: "background", cwd: rec.cwd, state: "done", startedAt: Date.parse("2026-07-18T10:00:05.000Z") }]);

  cli(["runs"], { SPOR_HOME: home, CLAUDE_CONFIG_DIR: configDir, SPOR_FAKE_AGENTS_JSON: agents });
  assert.strictEqual(runRecords(home)[0].state, "vanished");
});

test("spor runs: a credit-dead run reads as an ENVIRONMENT failure with the provider's own line retained", () => {
  const { home, repo } = fixture();
  const configDir = scratch("spor-runs-cc-");
  cli(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const stub = writeSpawnableNodeStub(home, "claude-ok", "process.exit(0);");
  // A LOCAL-mode dispatch binds its session too, so the run has the identity
  // that ties it to its own transcript (rather than to whatever else ran in
  // this checkout) — issue-spor-dispatch-run-liveness-same-cwd-misattribution.
  cli(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, CLAUDE_CONFIG_DIR: configDir, SPOR_SESSION_ID: "sid-credit" });
  const rec = runRecords(home)[0];
  assert.strictEqual(rec.session_id, "sid-credit", "local mode records the run's session identity");
  runner.atomicJson(runner.runPaths(home, rec.run_id).record, { ...rec, created_at: "2026-07-18T10:00:00.000Z" });
  writeTranscript(configDir, rec.cwd, "sid-credit", [
    { type: "assistant", timestamp: "2026-07-18T10:01:00Z", message: { content: [{ type: "text", text: "starting" }] } },
    { type: "system", subtype: "error", timestamp: "2026-07-18T10:02:00Z", content: "API Error: out of usage credits" },
  ]);

  const r = cli(["runs", "--json"], { SPOR_HOME: home, CLAUDE_CONFIG_DIR: configDir });
  const run = JSON.parse(r.stdout).runs[0];
  assert.strictEqual(run.state, "failed");
  assert.strictEqual(run.termination_class, "environment", "not a capability or implementation failure");
  assert.strictEqual(run.termination_signal, "credit-exhausted");
  assert.match(run.termination_reason, /out of usage credits/);
  assert.ok(run.transcript_path, "and a pointer to the evidence");
});

test("dispatch: a SIBLING agent's session is never adopted as this run's identity", () => {
  // issue-spor-dispatch-run-liveness-same-cwd-misattribution, at the capture
  // step: during the poll window our own agent is often unregistered while a
  // sibling in the same checkout already is. Binding "newest in this directory"
  // would stamp the run with the sibling's session — and every later inference
  // (liveness, transcript) would then be about the wrong run.
  const { home, repo } = fixture();
  const stub = writeSpawnableNodeStub(home, "claude-ok", "process.exit(0);");
  cli(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const base = { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub };

  // Learn the checkout this dispatch actually launches into…
  cli(["dispatch", "dec-x", "--no-brief"], base);
  const cwd = runRecords(home)[0].cwd;

  // …then dispatch again while a DIFFERENT agent is live in that same checkout.
  const sibling = JSON.stringify([
    { kind: "background", name: "some-other-node", sessionId: "sid-of-the-sibling", cwd, state: "running", startedAt: Date.now() },
  ]);
  cli(["dispatch", "dec-x", "--no-brief"], { ...base, SPOR_FAKE_AGENTS_JSON: sibling });
  for (const rec of runRecords(home)) {
    assert.notStrictEqual(rec.session_id, "sid-of-the-sibling", "a sibling's session is not this run's identity");
  }
});

test("dispatch: a PRE-LAUNCH refusal stays an explicit refusal — non-zero, a reason, and no phantom run record", () => {
  const { home, repo } = fixture();
  cli(["repos", "add", "demo", repo], { SPOR_HOME: home });
  // No claude on PATH: dispatch refuses before any side effect, so there is
  // nothing to record — an "or explicit refusal" outcome, not a run.
  const r = cli(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, PATH: pathWithOnlyGit() });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /claude CLI not on PATH/);
  assert.strictEqual(runRecords(home).length, 0, "a refusal launches nothing, so it records nothing");
});

test("dispatch: a spawn that fails AFTER the record is opened is recorded as failed_launch, not lost", () => {
  const { home, repo } = fixture();
  cli(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const r = cli(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: path.join(home, "no-such-claude") });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /could not launch/);
  const rec = runRecords(home)[0];
  assert.strictEqual(rec.state, "failed_launch");
  assert.strictEqual(rec.termination_class, "launch");
  assert.ok(rec.termination_reason, "the failure keeps its reason");
});

test("dispatch: a harness that exits non-zero without leaving an agent is recorded as failed_launch", () => {
  const { home, repo } = fixture();
  const configDir = scratch("spor-runs-cc-");
  cli(["repos", "add", "demo", repo], { SPOR_HOME: home });
  const stub = writeSpawnableNodeStub(home, "claude-boom", "process.exit(7);");
  cli(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, CLAUDE_CONFIG_DIR: configDir });
  const rec = runRecords(home)[0];
  assert.strictEqual(rec.state, "failed_launch");
  assert.strictEqual(rec.termination_class, "launch");
  assert.strictEqual(rec.launcher_exit, 7);
  assert.match(rec.termination_reason, /exited 7 without leaving a background agent/);
});
