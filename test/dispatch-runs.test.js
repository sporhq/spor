// Durable terminal records for dispatched runs
// (inc-spor-dispatch-session-vanished-2026-07-18). A `native-background` launch
// hands the child to the harness daemon and returns, so the launcher never sees
// it exit and `claude agents --json` lists only what is still LIVE — before this
// a finished run and a dead one were indistinguishable afterwards. Every case
// below must leave a queryable terminal record, or an explicit refusal.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
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

test("isRunLive: matches a bound session by id, an unbound one by checkout, and rejects a pre-launch agent", () => {
  const bound = { session_id: "s1", cwd: "/w", created_at: "2026-07-18T10:00:00.000Z" };
  assert.ok(runner.isRunLive(bound, [{ sessionId: "s1", cwd: "/other" }]));
  assert.ok(!runner.isRunLive(bound, [{ sessionId: "s2", cwd: "/w" }]));
  const unbound = { cwd: "/w", created_at: "2026-07-18T10:00:00.000Z" };
  assert.ok(runner.isRunLive(unbound, [{ cwd: "/w", startedAt: Date.parse("2026-07-18T10:00:05.000Z") }]));
  assert.ok(!runner.isRunLive(unbound, [{ cwd: "/w", startedAt: Date.parse("2026-07-18T09:00:00.000Z") }]));
  assert.ok(!runner.isRunLive(unbound, []));
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

test("finalizeRun: an unbound run is still resolved from the newest transcript in its checkout", () => {
  const configDir = scratch("spor-runs-cc-");
  const cwd = "/tmp/spor-runs-demo";
  const file = writeTranscript(configDir, cwd, "sid-late", [TOOL_RESULT, CLEAN_END]);
  const patch = runner.finalizeRun(
    { state: "running", cwd, created_at: "2026-07-18T10:00:00.000Z" },
    { alive: false, env: { CLAUDE_CONFIG_DIR: configDir }, now: () => "2026-07-18T10:10:00.000Z" }
  );
  assert.strictEqual(patch.state, "done");
  assert.strictEqual(patch.transcript_path, file, "the record points at the transcript it was read from");
});

test("finalizeRun: a transcript written BEFORE the run started belongs to an earlier session, not this run", () => {
  const configDir = scratch("spor-runs-cc-");
  const cwd = "/tmp/spor-runs-stale";
  const file = writeTranscript(configDir, cwd, "sid-old", [TOOL_RESULT, CLEAN_END]);
  const old = Date.parse("2026-07-18T08:00:00.000Z") / 1000;
  fs.utimesSync(file, old, old);
  const patch = runner.finalizeRun(
    { state: "running", cwd, created_at: "2026-07-18T10:00:00.000Z" },
    { alive: false, env: { CLAUDE_CONFIG_DIR: configDir }, now: () => "2026-07-18T10:10:00.000Z" }
  );
  assert.strictEqual(patch.termination_signal, "session-unbound", "an older transcript is not adopted as this run's");
});

// --- reconciliation over the record store ---------------------------------

test("reconcileRuns: resolves dead native runs, keeps live ones, and never touches supervised records", () => {
  const home = scratch("spor-runs-store-");
  const configDir = scratch("spor-runs-cc-");
  const cwd = "/tmp/spor-runs-recon";
  writeTranscript(configDir, cwd, "sid-dead", [TOOL_RESULT]);
  const dead = runner.beginNativeRun(home, { harness: "claude-code", name: "n-dead", nodeId: "issue-dead", cwd, now: () => "2026-07-18T10:00:00.000Z" });
  runner.updateRun(dead, { state: "running", session_id: "sid-dead" });
  const live = runner.beginNativeRun(home, { harness: "claude-code", name: "n-live", nodeId: "issue-live", cwd, now: () => "2026-07-18T10:00:00.000Z" });
  runner.updateRun(live, { state: "running", session_id: "sid-live" });
  // A supervised record: its own runner owns finalization, so reconciliation
  // must leave it exactly as found.
  runner.atomicJson(runner.runPaths(home, "sup-1").record, { run_id: "sup-1", harness: "codex", launch_mode: "supervised-jsonl", state: "running", created_at: "2026-07-18T10:00:00.000Z" });

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
});

test("reconcileRuns: a harness that could not be listed reconciles NOTHING (stale child state is not death)", () => {
  const home = scratch("spor-runs-store-");
  const rec = runner.beginNativeRun(home, { harness: "claude-code", name: "n", nodeId: "issue-x", cwd: "/tmp/nope", now: () => "2026-07-18T10:00:00.000Z" });
  runner.updateRun(rec, { state: "running" });
  const out = runner.reconcileRuns(home, { agents: [], enumerated: false, now: () => "2026-07-18T11:00:00.000Z" });
  assert.strictEqual(out[0].state, "running");
  assert.strictEqual(runRecords(home)[0].state, "running", "nothing written back");
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
  cli(["dispatch", "dec-x", "--no-brief"], { SPOR_HOME: home, SPOR_CLAUDE_CMD: stub, CLAUDE_CONFIG_DIR: configDir });
  const rec = runRecords(home)[0];
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
