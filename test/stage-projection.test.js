// THE READ MODEL OVER A RUN'S STAGE JOURNALS (lib/shell/stage-projection.js,
// task-spor-run-surfaces-read-stage-journal): what `spor runs`, `spor work
// --status`, `spor work --regate` and the flake-evidence debt read instead of
// `gate_state`/`gate_progress` bookkeeping on the run record.
//   1. a real gate workflow journal (driven through runGatePipeline over the
//      execution-store file journal) projects to its status, its verdict per
//      gate, the head it judged and the ledger stamp the save activity
//      journaled — settled, parked (a yield) and tombstoned (a refusal);
//   2. both journal homes are enumerated — beside the run record and beside
//      the execution record — oldest stage first, re-gate children by head;
//   3. the ledger is read log-first, then the journals, then (read-only) a
//      legacy record stamp; `owesEvidence` reads the same;
//   4. `spor runs <id>` prints the projection; a run with no journal prints
//      nothing new; an unreadable journal is REPORTED, never dropped;
//   5. `--status` renders the active slot's current stage from the journals.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const gates = require("../lib/kernel/gates.js");
const gateRunner = require("../lib/shell/gate-runner.js");
const wf = require("../lib/shell/gate-workflow.js");
const store = require("../lib/shell/execution-store.js");
const runs = require("../lib/shell/agent-dispatch-runner.js");
const sp = require("../lib/shell/stage-projection.js");
const { fakeClock } = require("../lib/kernel/workflow.js");

const RUN = "11111111-2222-3333-4444-555555555555";
const EXEC = "exec-0123456789abcdef";
const ITEM = { node_id: "task-demo", run_id: RUN, project: "demo" };

function factoryOf(payload) {
  const body = ["```json", JSON.stringify(payload), "```"].join("\n");
  const { factory, errors } = gates.parseFactory(body, { id: "factory-test", gateNodes: new Map() });
  assert.deepEqual(errors, [], errors.join("; "));
  return factory;
}
const FACTORY = factoryOf({ factory: "test", trusted_ref: "main", protected_paths: ["test/**"], test_lane_profile: "profile-test-writer", gates: [{ id: "acceptance", kind: "command", command: "npm test" }, { id: "review", kind: "agent-review", profile: "profile-review", cycles: 0 }] });
const PASS = '```json\n{"verdict":"pass"}\n```';

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spor-stage-projection-"));
}

// The deps of a gate pipeline that passes both gates at head `head`, over the
// journal handle `journal`; the save closures return the stamp the real deps
// return (the activity's journaled RESULT is the ledger).
function deps({ home, head = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", journal, preflight = null, saves = null }) {
  const clock = fakeClock(1_700_000_000_000);
  let seq = 0;
  const stamp = { key: RUN, gates: {} };
  return {
    now: () => clock.now(),
    sleep: async (ms) => clock.advanceBy(ms),
    stopping: () => false,
    workflowJournal: journal,
    ...(preflight ? { checkEvidenceOrigins: async () => preflight } : {}),
    changedPaths: async () => ({ ok: true, paths: ["lib/x.js"], head, base: "base0000", trustedRef: "main", trustedSha: "trust000", branch: "task-demo", cwd: path.join(home, "wt") }),
    runSuite: async () => ({ ok: true }),
    review: async () => ({ ok: true, text: PASS }),
    recordFact: async ({ id }) => ({ ok: true, id }),
    loadGateProgress: async ({ gate }) => stamp.gates[gate.id] || null,
    saveGateProgress: async ({ gate, progress }) => {
      stamp.gates[gate.id] = JSON.parse(JSON.stringify(progress));
      const out = { ...JSON.parse(JSON.stringify(stamp)), at: new Date(clock.now()).toISOString(), seq: ++seq };
      if (saves) saves.push(out);
      return out;
    },
  };
}

test("a settled gate journal projects to its verdicts, the judged head, the ledger the save journaled, and `settled`; a yielded one to `parked`; a tombstone to `tombstoned`", async () => {
  const home = scratch();
  try {
    const record = { run_id: RUN, node_id: "task-demo", gate_state: "passed", gate_settle_id: "nonce-1", gate_worker: "w1", gate_at: "2026-10-03T00:00:00.000Z" };
    runs.atomicJson(runs.runPaths(home, RUN).record, record);
    const abs = path.join(runs.runPaths(home, RUN).workflows, "gates-a0.workflow.jsonl");
    const saves = [];
    const res = await gateRunner.runGatePipeline({ item: ITEM, factory: FACTORY, deps: deps({ home, journal: () => store.openWorkflowJournalAt(abs, { stage: "gates-a0" }), saves }) });
    assert.equal(res.state, "passed", JSON.stringify(res));
    assert.ok(saves.length > 0, "the deps saved progress");

    const p = sp.projectRun(home, record);
    assert.deepEqual(p.stages.map((s) => [s.stage, s.kind, s.attempt, s.status, s.state, s.source]), [["gates-a0", "gates", 0, "settled", "passed", "run"]]);
    assert.equal(p.stages[0].head, "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
    assert.deepEqual(p.stages[0].version, { workflow: wf.WORKFLOW_NAME, version: wf.WORKFLOW_VERSION });
    assert.ok(p.stages[0].open && p.stages[0].open.digest, "the binding the attempt opened under is readable");
    assert.deepEqual(p.gates.map((g) => [g.gate, g.verdict, g.cycle, g.rescue, g.head]), [["acceptance", "passed", 0, 0, "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"], ["review", "passed", 0, 0, "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"]]);
    assert.equal(p.current.status, "settled", "nothing is open, so the current stage is the last");
    assert.equal(p.progress.source, "journal", "no log, so the ledger comes from the save activity's journaled result");
    assert.deepEqual(p.progress.stamp, saves[saves.length - 1]);
    assert.deepEqual(p.owed, []);
    assert.deepEqual({ state: p.state, settle_id: p.settle_id, worker: p.worker }, { state: "passed", settle_id: "nonce-1", worker: "w1" });
    const lines = sp.describeRun(p);
    assert.equal(lines[0], "  journal:    gates a0 — passed");
    assert.equal(lines[1], "  gate acceptance: passed @ a1b2c3d4e5f6");
    assert.equal(lines[2], "  gate review: passed @ a1b2c3d4e5f6");
    assert.equal(lines[3], "  ledger:     from the journal — attempt key 11111111-2222-3333-4444-555555555555");

    // A PARKED journal: the evidence preflight refuses, the workflow yields.
    const parkedAbs = path.join(runs.runPaths(home, RUN).workflows, "gates-a1.workflow.jsonl");
    const parked = await gateRunner.runGatePipeline({ item: { ...ITEM, attempt: 1 }, factory: FACTORY, deps: deps({ home, journal: () => store.openWorkflowJournalAt(parkedAbs, { stage: "gates-a1" }), preflight: { ok: false, reason: "pending flake evidence belongs to a different or unknown graph" } }) });
    assert.equal(parked.state, "interrupted");
    const p2 = sp.projectRun(home, record);
    assert.deepEqual(p2.stages.map((s) => [s.stage, s.status, s.state]), [["gates-a0", "settled", "passed"], ["gates-a1", "parked", "interrupted"]]);
    assert.match(p2.stages[1].parked.reason, /different or unknown graph/);
    assert.deepEqual([p2.current.stage, p2.current.status], ["gates-a1", "parked"], "the open stage is the current one");
    assert.equal(sp.describeRun(p2)[1], "  journal:    gates a1 — parked — pending flake evidence belongs to a different or unknown graph");

    // A TOMBSTONED journal (a refused attempt).
    const tombAbs = path.join(runs.runPaths(home, RUN).workflows, "gates-a2.workflow.jsonl");
    const h = store.openWorkflowJournalAt(tombAbs, { stage: "gates-a2" });
    h.persist({ kind: "version", spec: 1, workflow: wf.WORKFLOW_NAME, version: wf.WORKFLOW_VERSION });
    h.persist({ kind: "tombstone", reason: "definition_mismatch", detail: { reason: "definition_mismatch", detail: "edited mid-flight" } });
    const p3 = sp.projectRun(home, record);
    assert.deepEqual(p3.stages[2] && [p3.stages[2].stage, p3.stages[2].status, p3.stages[2].tombstone.reason], ["gates-a2", "tombstoned", "definition_mismatch"]);
    assert.equal(sp.describeRun(p3)[2], "  journal:    gates a2 — refused (definition_mismatch)");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("both journal homes are enumerated, oldest stage first, re-gate children by their journal's age (the LAST re-gate's verdict is the gate's); names that are not stage journals are ignored", () => {
  const home = scratch();
  try {
    const record = { run_id: RUN, impl_claim: { store: "local", tenant: "local", execution_id: EXEC } };
    const runDir = runs.runPaths(home, RUN).workflows;
    const execDir = path.dirname(store.workflowJournalPath(home, "local", EXEC));
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(execDir, { recursive: true });
    for (const name of ["gates-a0", "gates-regate-ffff0000ffff0000ffff0000ffff0000ffff0000-a0", "gates-regate-0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa-a0", "integration-a0", "implementation-a0", "gates-a1"]) fs.writeFileSync(path.join(runDir, `${name}.workflow.jsonl`), "");
    // The ffff re-gate ran FIRST (older journal), the 0000 one second: hex
    // order would put them the other way round and keep the superseded verdict.
    const t0 = Date.parse("2026-10-03T00:00:00Z") / 1000;
    fs.utimesSync(path.join(runDir, "gates-regate-ffff0000ffff0000ffff0000ffff0000ffff0000-a0.workflow.jsonl"), t0, t0);
    fs.utimesSync(path.join(runDir, "gates-regate-0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa-a0.workflow.jsonl"), t0 + 60, t0 + 60);
    fs.writeFileSync(path.join(runDir, "notes.txt"), "");
    fs.writeFileSync(path.join(runDir, "gates-regate-unknown-a0.workflow.jsonl"), "", "utf8"); // a non-hex head is not a stage journal
    fs.writeFileSync(path.join(runDir, sp.PROGRESS_LOG), "");
    fs.writeFileSync(path.join(execDir, `${EXEC}.integration-a1.workflow.jsonl`), "");
    fs.writeFileSync(path.join(execDir, `${EXEC}.workflow.jsonl`), ""); // the one-pipeline journal (no stage): not a stage journal
    fs.writeFileSync(path.join(execDir, `exec-other.gates-a0.workflow.jsonl`), ""); // another execution's
    const found = sp.stageJournals(home, record);
    assert.deepEqual(found.map((j) => [j.stage, j.kind, j.attempt, j.head, j.source]), [
      ["implementation-a0", "implementation", 0, null, "run"],
      ["gates-a0", "gates", 0, null, "run"],
      ["gates-regate-ffff0000ffff0000ffff0000ffff0000ffff0000-a0", "gates-regate", 0, "ffff0000ffff0000ffff0000ffff0000ffff0000", "run"],
      ["gates-regate-0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa-a0", "gates-regate", 0, "0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa", "run"],
      ["integration-a0", "integration", 0, null, "run"],
      ["gates-a1", "gates", 1, null, "run"],
      ["integration-a1", "integration", 1, null, "execution"],
    ]);
    assert.deepEqual(sp.parseStageName("gates-regate-abc-a3"), { stage: "gates-regate-abc-a3", kind: "gates-regate", head: "abc", attempt: 3 });
    assert.equal(sp.parseStageName("gates"), null);
    // Empty journals project to `empty`, and the run's current stage is the last.
    const p = sp.projectRun(home, record);
    assert.ok(p.stages.every((s) => s.status === "empty"));
    assert.equal(p.current.stage, "integration-a1");
    assert.deepEqual(sp.describeRun(p).filter((l) => /empty/.test(l)).length, 7);
    // The per-gate fold keeps the LAST re-gate's verdict: the older (ffff)
    // journal failed the gate, the newer (0000) passed it.
    const judge = (head, verdict) => JSON.stringify({ kind: "effect", key: `${RUN}/gates/a0/e0/judge/r0/acceptance/c0/judge#1`, result: { outcome: { verdict, passed: verdict === "passed", head } } }) + "\n";
    fs.writeFileSync(path.join(runDir, "gates-regate-ffff0000ffff0000ffff0000ffff0000ffff0000-a0.workflow.jsonl"), judge("ffff0000ffff0000ffff0000ffff0000ffff0000", "failed"));
    fs.writeFileSync(path.join(runDir, "gates-regate-0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa-a0.workflow.jsonl"), judge("0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa", "passed"));
    fs.utimesSync(path.join(runDir, "gates-regate-ffff0000ffff0000ffff0000ffff0000ffff0000-a0.workflow.jsonl"), t0, t0);
    fs.utimesSync(path.join(runDir, "gates-regate-0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa-a0.workflow.jsonl"), t0 + 60, t0 + 60);
    const folded = sp.projectRun(home, record);
    assert.deepEqual(folded.gates.map((g) => [g.gate, g.verdict, g.head]), [["acceptance", "passed", "0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa"]], "the newer re-gate's verdict stands");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the ledger reads log-first, then a legacy record stamp (read-only), then the journals; the writer continues from the same reading; owesEvidence reads the same; the integration and implementation journals project their yields and landings", () => {
  const home = scratch();
  try {
    const record = { run_id: RUN, gate_progress: { key: RUN, seq: 1, gates: { acceptance: { evidence: { complete: false, gate: { id: "acceptance" } } } } } };
    runs.atomicJson(runs.runPaths(home, RUN).record, { ...record, gate_state: "running", gate_settle_id: "o", gate_regate_count: 0 });
    assert.equal(sp.latestProgress(home, record).source, "record");
    assert.equal(sp.owesEvidence(home, record), true);
    // A gate journal holding a save result does NOT outrank a legacy record
    // copy: before the log, the saves made inside another activity (a flake
    // filing intent, a fix's launch) rewrote the record and were never
    // journaled as their own step, so the record is the superset — a journal
    // that says "complete" here is a STALE reading of a later record stamp.
    const g = store.openWorkflowJournalAt(path.join(runs.runPaths(home, RUN).workflows, "gates-a0.workflow.jsonl"), { stage: "gates-a0" });
    g.persist({ kind: "effect", key: `${RUN}/gates/a0/e0/progress/acceptance/saveGateProgress#1`, result: { key: RUN, seq: 0, at: "2026-10-03T00:00:01.000Z", gates: { acceptance: { evidence: { complete: true } } } } });
    assert.equal(sp.latestProgress(home, record).source, "record");
    assert.equal(sp.owesEvidence(home, record), true, "the record's owed row stands over the stale journal save");
    // A post-log run whose log is lost (no record stamp) falls back to the journal…
    const lost = { run_id: RUN };
    assert.equal(sp.latestProgress(home, lost).source, "journal");
    assert.equal(sp.owesEvidence(home, lost), false);
    // …and the WRITER continues from that same reading: its first append keeps
    // the journal's rows rather than starting from an empty ledger.
    runs.atomicJson(runs.runPaths(home, RUN).record, { run_id: RUN, gate_state: "running", gate_settle_id: "o", gate_regate_count: 0 });
    const cont = sp.writeGateProgress(home, RUN, { gates: { review: { fixes: 1 } } }, { key: RUN, attempt: 1, own: "o" });
    assert.equal(cont.ok, true, cont.reason);
    assert.deepEqual(Object.keys(cont.progress.gates).sort(), ["acceptance", "review"], "the journal's row survived the first append");
    assert.equal(cont.progress.seq, 1);
    fs.unlinkSync(sp.progressLogPath(home, RUN));
    runs.atomicJson(runs.runPaths(home, RUN).record, { ...record, gate_state: "running", gate_settle_id: "o", gate_regate_count: 0 });
    // The log outranks both.
    const w = sp.writeGateProgress(home, RUN, { gates: { acceptance: { evidence: { complete: false, gate: { id: "acceptance" } } } } }, { key: RUN, attempt: 1, own: "o" });
    assert.equal(w.ok, true, w.reason);
    assert.equal(w.progress.seq, 2, "continued from the legacy record stamp (seq 1), not the journal (seq 0)");
    assert.equal(sp.latestProgress(home, record).source, "log");
    assert.equal(sp.owesEvidence(home, record), true);
    assert.deepEqual(sp.projectRun(home, record).owed, [{ row: "acceptance", carryKey: null, rescue: 0, attempt: null }]);
    assert.deepEqual(runs.readJson(runs.runPaths(home, RUN).record).gate_progress, record.gate_progress, "the legacy stamp is never rewritten");
    assert.match(sp.describeRun(sp.projectRun(home, record)).find((l) => /ledger/.test(l)), /from the log — attempt key .*; 1 flake obligation\(s\) still owed/);

    // The other two stages: a yielded integration journal is parked; a landed one is settled `landed`.
    const i = store.openWorkflowJournalAt(path.join(runs.runPaths(home, RUN).workflows, "integration-a0.workflow.jsonl"), { stage: "integration-a0" });
    i.persist({ kind: "effect", key: `${RUN}/integration/open`, result: { digest: "sha256:x" } });
    i.persist({ kind: "effect", key: `${RUN}/integration/yield/0/parked`, result: { state: "interrupted", reason: "ci outage" } });
    i.persist({ kind: "now", key: `${RUN}/integration/yield/0/now`, at: 1 });
    i.persist({ kind: "timer", key: `${RUN}/integration/yield/0`, fireAt: 2 });
    let p = sp.projectRun(home, record);
    assert.deepEqual([p.current.stage, p.current.status, p.current.state], ["integration-a0", "parked", "interrupted"]);
    i.persist({ kind: "effect", key: `${RUN}/integration/attempt/1/land#1`, result: { ok: true, sha: "cafe0000cafe0000cafe", detail: "landed" } });
    p = sp.projectRun(home, record);
    assert.deepEqual([p.stages.at(-1).status, p.stages.at(-1).state, p.stages.at(-1).landed.sha], ["settled", "landed", "cafe0000cafe0000cafe"]);
    assert.match(sp.describeRun(p).find((l) => /integration a0/.test(l)), /integration a0 — landed \(landed cafe0000cafe\)/);
    const m = store.openWorkflowJournalAt(path.join(runs.runPaths(home, RUN).workflows, "implementation-a0.workflow.jsonl"), { stage: "implementation-a0" });
    m.persist({ kind: "effect", key: `${RUN}/implementation/open`, result: {} });
    m.persist({ kind: "effect", key: `${RUN}/implementation/a1/i1/backoff-parked`, result: { state: "interrupted", reason: "backoff" } });
    p = sp.projectRun(home, record);
    assert.deepEqual(p.stages.map((s) => [s.kind, s.status]), [["implementation", "parked"], ["gates", "running"], ["integration", "settled"]]);
    assert.equal(p.current.stage, "gates-a0", "the latest OPEN stage is current");

    // An unreadable journal is reported, never dropped.
    fs.writeFileSync(path.join(runs.runPaths(home, RUN).workflows, "gates-a1.workflow.jsonl"), "{not json}\n{\"kind\":\"effect\"}\n");
    p = sp.projectRun(home, record);
    assert.equal(p.unreadable.length, 1);
    assert.match(p.unreadable[0].error, /corrupt at line 1/);
    assert.match(sp.describeRun(p).at(-1), /^  journal: {4}gates-a1 — UNREADABLE/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("`spor runs <id>` prints the projection after the record's gate lines; a run with no journal prints nothing new; `--json` keeps the record shape", async () => {
  const home = scratch();
  try {
    const { loadConfig } = require("../lib/config.js");
    const cli = require("../bin/spor.js");
    const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_MODE: "local" } });
    const record = { run_id: RUN, node_id: "task-demo", harness: "claude-code", state: "done", terminal_state: "resolved", terminal_enforced: true, created_at: "2026-10-03T00:00:00.000Z", finished_at: "2026-10-03T00:01:00.000Z", gate_state: "passed", gate_settle_id: "nonce", gate_head: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", pid: 0 };
    runs.atomicJson(runs.runPaths(home, RUN).record, record);
    const capture = async (values) => {
      const lines = [];
      const orig = process.stdout.write;
      process.stdout.write = (s) => { lines.push(String(s)); return true; };
      try { await cli.COMMANDS.runs.run(cfg, { values, positionals: [RUN] }); } finally { process.stdout.write = orig; }
      return lines.join("");
    };
    const bare = await capture({});
    assert.match(bare, /gate: {7}passed/);
    assert.doesNotMatch(bare, /journal:/, "no journal, nothing new");
    const abs = path.join(runs.runPaths(home, RUN).workflows, "gates-a0.workflow.jsonl");
    const res = await gateRunner.runGatePipeline({ item: ITEM, factory: FACTORY, deps: deps({ home, journal: () => store.openWorkflowJournalAt(abs, { stage: "gates-a0" }) }) });
    assert.equal(res.state, "passed");
    const withJournal = await capture({});
    assert.match(withJournal, /\n {2}journal: {4}gates a0 — passed\n {2}gate acceptance: passed @ a1b2c3d4e5f6\n {2}gate review: passed @ a1b2c3d4e5f6\n {2}ledger: {5}from the journal/);
    const json = JSON.parse(await capture({ json: true }));
    assert.equal(json.runs[0].run_id, RUN);
    assert.equal(json.runs[0].stages, undefined, "the JSON surface is the record as before");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
