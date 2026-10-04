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
    // A parked stage says when it is due back (its own timer) and how many
    // times it yielded this way; the scan reads the same fields.
    assert.match(sp.describeRun(p2)[2], /^\s+due \d{4}-.*; yielded 1 time\(s\) in a row for this reason$/);
    assert.ok(p2.stages[1].due > 0, "the yield's durable timer is the due time");
    assert.equal(p2.stages[1].reoffers, 1);
    assert.equal(p2.open, "gates-a1");

    // A TOMBSTONED journal (a refused attempt).
    const tombAbs = path.join(runs.runPaths(home, RUN).workflows, "gates-a2.workflow.jsonl");
    const h = store.openWorkflowJournalAt(tombAbs, { stage: "gates-a2" });
    h.persist({ kind: "version", spec: 1, workflow: wf.WORKFLOW_NAME, version: wf.WORKFLOW_VERSION });
    h.persist({ kind: "tombstone", reason: "definition_mismatch", detail: { reason: "definition_mismatch", detail: "edited mid-flight" } });
    const p3 = sp.projectRun(home, record);
    assert.deepEqual(p3.stages[2] && [p3.stages[2].stage, p3.stages[2].status, p3.stages[2].tombstone.reason], ["gates-a2", "tombstoned", "definition_mismatch"]);
    assert.equal(sp.describeRun(p3)[3], "  journal:    gates a2 — refused (definition_mismatch)");
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
    // A gate journal holding a save result OUTRANKS a legacy record copy
    // (log, then journals, then the record as the read-only last resort).
    const g = store.openWorkflowJournalAt(path.join(runs.runPaths(home, RUN).workflows, "gates-a0.workflow.jsonl"), { stage: "gates-a0" });
    g.persist({ kind: "effect", key: `${RUN}/gates/a0/e0/progress/acceptance/saveGateProgress#1`, result: { key: RUN, seq: 0, at: "2026-10-03T00:00:01.000Z", gates: { acceptance: { evidence: { complete: true } } } } });
    // …unless the record's stamp is strictly later (seq 1 > 0): a pre-log save
    // rewrote it unjournaled, so the journal is stale and the owed row stands.
    assert.equal(sp.latestProgress(home, record).source, "record");
    assert.equal(sp.owesEvidence(home, record), true);
    const later = { ...record, gate_progress: { ...record.gate_progress, seq: 0, at: "2026-10-03T00:00:00.000Z" } };
    assert.equal(sp.latestProgress(home, later).source, "journal", "an older record stamp yields to the journal");
    assert.equal(sp.owesEvidence(home, later), false);
    // A post-log run whose log is lost (no record stamp) falls back to the journal…
    const lost = { run_id: RUN };
    assert.equal(sp.latestProgress(home, lost).source, "journal");
    assert.equal(sp.owesEvidence(home, lost), false);
    // …and with no journal at all the record's legacy stamp is the last resort.
    const bare = scratch();
    try {
      assert.equal(sp.latestProgress(bare, record).source, "record");
      assert.equal(sp.owesEvidence(bare, record), true);
    } finally { fs.rmSync(bare, { recursive: true, force: true }); }
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
    assert.equal(w.progress.seq, 2, "continued from the later legacy record stamp (seq 1), not the journal (seq 0)");
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

test("projectRun.gates reflects only the latest attempt's gate set; a gate a later attempt dropped is not a current verdict", () => {
  const home = scratch();
  try {
    const record = { run_id: RUN };
    const dir = runs.runPaths(home, RUN).workflows;
    fs.mkdirSync(dir, { recursive: true });
    const judge = (a, gate, verdict) => JSON.stringify({ kind: "effect", key: `${RUN}/gates/a${a}/e0/judge/r0/${gate}/c0/judge#1`, result: { outcome: { verdict, head: "abc" } } }) + "\n";
    fs.writeFileSync(path.join(dir, "gates-a0.workflow.jsonl"), judge(0, "acceptance", "passed") + judge(0, "review", "failed"));
    fs.writeFileSync(path.join(dir, "gates-a1.workflow.jsonl"), judge(1, "acceptance", "passed"));
    assert.deepEqual(sp.projectRun(home, record).gates.map((g) => [g.gate, g.attempt]), [["acceptance", 1]]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("claimPipeline refuses a new attempt over owed flake evidence WITHOUT an owesEvidence override (the callee reads the projection; a boolean override is ignored)", () => {
  const home = scratch();
  try {
    const file = runs.runPaths(home, RUN).record;
    runs.atomicJson(file, { run_id: RUN, node_id: "task-demo", gate_regate_count: 0 });
    const first = runs.claimPipeline(home, RUN, { workerId: "w1" });
    assert.equal(first.ok, true, first.refused);
    sp.writeGateProgress(home, RUN, { gates: { acceptance: { evidence: { complete: false, gate: { id: "acceptance" } } } } }, { key: RUN, attempt: 1, own: first.token });
    const reopen = { settleId: first.token, regateCount: 0, state: null };
    const claim = runs.claimPipeline(home, RUN, { workerId: "w2", reopen });
    assert.equal(claim.ok, false);
    assert.match(claim.refused, /flake occurrence publication is still owed/);
    // Point 7 of the slice: `owesEvidence: false` is NOT an override — only a
    // function of the fresh record is read; a boolean falls back to the projection.
    const ignored = runs.claimPipeline(home, RUN, { workerId: "w2", reopen, owesEvidence: false });
    assert.equal(ignored.ok, false);
    assert.match(ignored.refused, /flake occurrence publication is still owed/);
    const fn = runs.claimPipeline(home, RUN, { workerId: "w2", reopen, owesEvidence: () => false });
    assert.equal(fn.ok, true, fn.refused);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------- the pipeline lease (task-spor-delete-loop-resume-machinery-after-workflow-stages) ----------------

test("the pipeline lease is a journaled claim beside the stage journals: claimed, renewed, released; held only while unexpired, unreleased and its worker live", () => {
  const home = scratch();
  try {
    const file = runs.runPaths(home, RUN).record;
    runs.atomicJson(file, { run_id: RUN, node_id: "task-demo", state: "done", terminal_state: "resolved", terminal_enforced: true });
    assert.equal(sp.pipelineLease(home, { run_id: RUN }), null, "no claim yet");
    const t0 = Date.parse("2026-10-03T10:00:00Z");
    const claim = runs.claimPipeline(home, RUN, { workerId: "w1", factory: "factory-x", nowMs: () => t0, now: () => new Date(t0).toISOString() });
    assert.equal(claim.ok, true, claim.refused);
    assert.ok(fs.existsSync(sp.pipelineLogPath(home, { run_id: RUN })), "the lease log sits beside the stage journals");
    const lease = sp.pipelineLease(home, { run_id: RUN });
    assert.deepEqual([lease.token, lease.worker, lease.factory, lease.attempt, lease.released_at], [claim.token, "w1", "factory-x", 0, null]);
    assert.equal(Date.parse(lease.expires_at), t0 + sp.PIPELINE_LEASE_TTL_MS);
    // The record carries NO transitional state: no gate_state, no gate_settle_id.
    const rec = runs.readJson(file);
    assert.equal(rec.gate_state, undefined);
    assert.equal(rec.gate_settle_id, undefined);
    assert.equal(rec.gate_worker, undefined);
    // Held while the worker is live and the TTL has not passed.
    assert.equal(sp.leaseHeld(lease, { now: () => t0 + 1000, ownerLive: () => true }), true);
    assert.equal(sp.leaseHeld(lease, { now: () => t0 + 1000, ownerLive: () => false }), false, "a dead worker's lease is open");
    assert.equal(sp.leaseHeld(lease, { now: () => t0 + sp.PIPELINE_LEASE_TTL_MS + 1, ownerLive: () => true }), false, "an expired lease is open even under a live worker");
    // A second worker cannot take a held lease; a dead owner's is taken over.
    const rival = runs.claimPipeline(home, RUN, { workerId: "w2", ownerLive: () => true, nowMs: () => t0 + 1000 });
    assert.equal(rival.ok, false);
    assert.match(rival.refused, /being gated right now by worker w1/);
    assert.match(runs.claimPipeline(home, RUN, { ownerLive: () => true, nowMs: () => t0 + 1000 }).refused, /being gated right now/, "a caller with no worker id is a stranger to every lease");
    assert.equal(sp.pipelineLease(home, { run_id: RUN }).token, claim.token, "a refused claim appends nothing that reads back");
    // Renewal moves the expiry; only the holder renews.
    const renewed = runs.renewPipeline(home, RUN, { workerId: "w1", nowMs: () => t0 + 60000 });
    assert.equal(renewed.ok, true);
    assert.equal(Date.parse(renewed.lease.expires_at), t0 + 60000 + sp.PIPELINE_LEASE_TTL_MS);
    assert.equal(runs.renewPipeline(home, RUN, { workerId: "w2" }).ok, false, "another worker renews nothing");
    // Release: the lease reads open at once, whatever the TTL says.
    assert.equal(runs.releasePipeline(home, RUN, "not-the-token").ok, false);
    assert.equal(runs.releasePipeline(home, RUN, claim.token).ok, true);
    const released = sp.pipelineLease(home, { run_id: RUN });
    assert.ok(released.released_at);
    assert.equal(sp.leaseHeld(released, { now: () => t0 + 1000, ownerLive: () => true }), false);
    assert.equal(runs.releasePipeline(home, RUN, claim.token).ok, false, "a release is once");
    // The settle's compare-and-swap reads the lease: the holder's `own` lands,
    // a stranger's does not; a re-claim replaces the token.
    assert.equal(runs.stampGateState(home, RUN, { gate_fix_run_id: "fix-1" }, { own: "stranger" }).gate_fix_run_id, undefined);
    assert.equal(runs.stampGateState(home, RUN, { gate_fix_run_id: "fix-1" }, { own: claim.token }).gate_fix_run_id, "fix-1");
    const taker = runs.claimPipeline(home, RUN, { workerId: "w2", factory: "factory-x", ownerLive: () => true, nowMs: () => t0 + 2000 });
    assert.equal(taker.ok, true, taker.refused);
    assert.equal(runs.stampGateState(home, RUN, { gate_fix_run_id: "fix-2" }, { own: claim.token }).gate_fix_run_id, "fix-1", "the old token no longer owns the pipeline");
    assert.equal(runs.stampGateState(home, RUN, { gate_fix_run_id: "fix-2" }, { own: taker.token }).gate_fix_run_id, "fix-2");
    // The ledger writer's unowned arm refuses a pipeline that has ever been claimed.
    assert.match(sp.writeGateProgress(home, RUN, { gates: {} }, { key: RUN, attempt: 1 }).reason, /owner changed/);
    assert.equal(sp.writeGateProgress(home, RUN, { gates: {} }, { key: RUN, attempt: 1, own: taker.token }).ok, true);
    // The projection carries the lease and describes it.
    const p = sp.projectRun(home, runs.readJson(file));
    assert.equal(p.lease.token, taker.token);
    assert.ok(sp.describeRun(p).some((l) => /^\s+lease:\s+held by w2 until .* \(factory factory-x\)$/.test(l)), sp.describeRun(p).join("\n"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a reopen is a compare-and-swap on the lease token, the attempt and the state, and only a new attempt moves the lease attempt", () => {
  const home = scratch();
  try {
    const file = runs.runPaths(home, RUN).record;
    runs.atomicJson(file, { run_id: RUN, node_id: "task-demo", gate_state: "failed", gate_settle_id: "settled-nonce", gate_regate_count: 0 });
    // A record settled before any lease: its gate_settle_id is the current token.
    assert.equal(runs.claimPipeline(home, RUN, { workerId: "w", reopen: { settleId: "other", regateCount: 0, state: "failed" } }).refused, "the prior judgement changed before re-gate could claim it");
    const re = runs.claimPipeline(home, RUN, { workerId: "w", reopen: { settleId: "settled-nonce", regateCount: 0, state: "failed" } });
    assert.equal(re.ok, true, re.refused);
    assert.equal(re.lease.attempt, 1, "a new attempt — its identity is the lease's");
    assert.equal(sp.pipelineAttempt(re.record, re.lease), 1);
    assert.equal(re.record.gate_regate_count, 0, "the record's legacy field is never written again");
    assert.ok(re.lease.regated_at, "the lease carries when the attempt was opened");
    assert.equal(re.record.gate_state, null, "the prior verdict is cleared");
    assert.equal(re.record.gate_settle_id, null, "and so is the prior settle nonce — a stale nonce never stands in for the lease");
    assert.equal(re.lease.attempt, 1);
    assert.equal(re.lease.reopen, true);
    // Settled again under the new token; a RESUME keeps the attempt.
    runs.stampGateState(home, RUN, { gate_state: "failed", gate_settle_id: re.token }, { own: re.token });
    assert.match(runs.claimPipeline(home, RUN, { workerId: "w", reopen: { settleId: re.token, regateCount: 1, state: "failed", resume: true } }).refused, /no unsettled attempt to resume/);
    runs.stampGateState(home, RUN, { gate_state: null }, { own: re.token, force: true });
    const resumed = runs.claimPipeline(home, RUN, { workerId: "w", reopen: { settleId: re.token, regateCount: 1, state: null, resume: true } });
    assert.equal(resumed.ok, true, resumed.refused);
    assert.equal(sp.pipelineAttempt(resumed.record, resumed.lease), 1, "a resume opens no new attempt");
    assert.equal(resumed.lease.resume, true);
    // A settled pass/park/superseded is never reopened.
    runs.stampGateState(home, RUN, { gate_state: "passed" }, { own: resumed.token });
    assert.match(runs.claimPipeline(home, RUN, { workerId: "w", reopen: { settleId: resumed.token, regateCount: 1, state: "passed" } }).refused, /already settled as 'passed'/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------- yields, due times and the re-offer count ----------------

function yieldJournal(entries) {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
const Y = (n, result, { at = null, timer = null } = {}) => [
  { kind: "effect", key: `${RUN}/gates/a0/e${n}/yield/yield#1`, result },
  ...(at != null ? [{ kind: "now", key: `${RUN}/gates/a0/e${n}/yield/now#1`, at }] : []),
  ...(timer != null ? [{ kind: "timer", key: `${RUN}/gates/a0/e${n}/yield/timer#1`, fireAt: timer }] : []),
];

test("projectJournal reads a parked journal's yields: the due time is the last yield's timer, and `reoffers` counts consecutive identical reasons — a pause inside its bound is skipped, a fallback hand-off resets", () => {
  const t = Date.parse("2026-10-03T12:00:00Z");
  const base = [{ kind: "version", spec: 1, workflow: "gates", version: 3 }, { kind: "effect", key: `${RUN}/gates/a0/e0/open#1`, result: { digest: "d", opened_at: "2026-10-03T11:00:00.000Z" } }];
  const same = { state: "interrupted", reason: "flake occurrence evidence is pending graph publication" };
  // Three identical yields, the last with its timer: due at the timer, three re-offers.
  let p = sp.projectJournal([...base, ...Y(0, same, { at: t, timer: t + 1000 }), ...Y(1, same, { at: t + 2000, timer: t + 3000 }), ...Y(2, same, { at: t + 4000, timer: t + 5000 })]);
  assert.deepEqual([p.status, p.state, p.due, p.reoffers, p.opened_at], ["parked", "interrupted", t + 5000, 3, "2026-10-03T11:00:00.000Z"]);
  assert.equal(p.yields.length, 3);
  // A yield with no timer behind it (a crash between the two) is due now.
  p = sp.projectJournal([...base, ...Y(0, same, { at: t })]);
  assert.deepEqual([p.status, p.due, p.reoffers], ["parked", 0, 1]);
  // A differing reason breaks the run.
  p = sp.projectJournal([...base, ...Y(0, same, { at: t, timer: t + 1 }), ...Y(1, { state: "interrupted", reason: "another" }, { at: t + 2, timer: t + 3 }), ...Y(2, same, { at: t + 4, timer: t + 5 })]);
  assert.equal(p.reoffers, 1);
  // A pause inside its bound neither counts nor breaks; an expired one counts.
  const paused = { ...same, paused_until: t + 600000, paused_profile: "profile-codex-review" };
  p = sp.projectJournal([...base, ...Y(0, same, { at: t, timer: t + 1 }), ...Y(1, paused, { at: t + 2, timer: t + 600000 }), ...Y(2, same, { at: t + 600001, timer: t + 600002 })]);
  assert.equal(p.reoffers, 2, "the pause is skipped, the count continues across it");
  p = sp.projectJournal([...base, ...Y(0, paused, { at: t, timer: t + 600000 })]);
  assert.deepEqual([p.reoffers, p.due], [0, t + 600000], "a pause alone is not a re-offer; it is due at its wake");
  p = sp.projectJournal([...base, ...Y(0, { ...same, paused_until: t - 1000 }, { at: t, timer: t + 1 })]);
  assert.equal(p.reoffers, 1, "an expired pause counts");
  // A fallback hand-off starts the count again.
  p = sp.projectJournal([...base, ...Y(0, same, { at: t, timer: t + 1 }), ...Y(1, same, { at: t + 2, timer: t + 3 }), ...Y(2, { state: "interrupted", reason: "routed to the fallback", fallback_route: true }, { at: t + 4, timer: t + 5 }), ...Y(3, same, { at: t + 6, timer: t + 7 })]);
  assert.equal(p.reoffers, 1);
  assert.equal(sp.consecutiveYields([]), 0);
  // The settled closing entry of the integration and implementation stages.
  const closed = sp.projectJournal([{ kind: "effect", key: `${RUN}/integration/open`, result: { opened_at: "2026-10-03T11:00:00.000Z" } }, { kind: "effect", key: `${RUN}/integration/settled`, result: { state: "failed" } }]);
  assert.deepEqual([closed.status, closed.state], ["settled", "failed"]);
  const impl = sp.projectJournal([{ kind: "effect", key: `${RUN}/implementation/open`, result: {} }, { kind: "effect", key: `${RUN}/implementation/settled`, result: { state: "candidate" } }]);
  assert.deepEqual([impl.status, impl.state], ["settled", "candidate"]);
});

test("same-attempt re-gate children order by their journaled opened_at, not by mtime; a corrupt gate journal is flagged by latestProgress and projectRun, never skipped in silence", () => {
  const home = scratch();
  try {
    const record = { run_id: RUN };
    const runDir = runs.runPaths(home, RUN).workflows;
    fs.mkdirSync(runDir, { recursive: true });
    const judge = (head, verdict, openedAt) => yieldJournal([
      { kind: "effect", key: `${RUN}/gates/a0/e0/open#1`, result: { digest: "d", opened_at: openedAt } },
      { kind: "effect", key: `${RUN}/gates/a0/e0/judge/r0/acceptance/c0/judge#1`, result: { outcome: { verdict, passed: verdict === "passed", head } } },
    ]);
    const older = `gates-regate-${"f".repeat(40)}-a0.workflow.jsonl`;
    const newer = `gates-regate-${"0".repeat(40)}-a0.workflow.jsonl`;
    fs.writeFileSync(path.join(runDir, older), judge("f".repeat(40), "failed", "2026-10-03T10:00:00.000Z"));
    fs.writeFileSync(path.join(runDir, newer), judge("0".repeat(40), "passed", "2026-10-03T10:05:00.000Z"));
    // mtime says the OPPOSITE of opened_at: the newer-opened file is older on disk.
    const t0 = Date.parse("2026-10-03T00:00:00Z") / 1000;
    fs.utimesSync(path.join(runDir, newer), t0, t0);
    fs.utimesSync(path.join(runDir, older), t0 + 600, t0 + 600);
    assert.deepEqual(sp.stageJournals(home, record).map((j) => j.head[0]), ["f", "0"], "opened_at wins over mtime");
    assert.deepEqual(sp.projectRun(home, record).gates.map((g) => [g.verdict, g.head[0]]), [["passed", "0"]], "the LAST-opened re-gate's verdict stands");

    // A corrupt interior line in a gate journal: reported, not skipped.
    fs.writeFileSync(path.join(runDir, "gates-a0.workflow.jsonl"), '{"kind":"version"}\n{not json\n{"kind":"effect","key":"x/saveGateProgress#1","result":{"key":"k"}}\n');
    const lp = sp.latestProgress(home, record);
    assert.equal(lp.unreadable.length, 1);
    assert.match(lp.unreadable[0].error, /corrupt at line 2/);
    const p = sp.projectRun(home, record);
    assert.ok(p.unreadable.some((u) => /gates-a0/.test(u.path)));
    assert.ok(sp.describeRun(p).some((l) => /gates-a0 — UNREADABLE/.test(l)));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("openPipelineCandidates: a record is a candidate only when a lease, a stage journal or a gate-armed dispatch (gate_factory / impl_claim.factory) says a pipeline was owed", () => {
  const home = scratch();
  try {
    const mk = (id, extra = {}) => {
      const r = { run_id: id, node_id: `task-${id}`, state: "done", terminal_state: "resolved", terminal_enforced: true, ...extra };
      runs.atomicJson(runs.runPaths(home, id).record, r);
      return r;
    };
    const bare = mk("run-bare");
    const stamped = mk("run-stamped", { gate_factory: "factory-x" });
    const claimed = mk("run-claimed");
    runs.claimPipeline(home, "run-claimed", { workerId: "w", factory: "factory-y" });
    const journaled = mk("run-journaled");
    fs.mkdirSync(runs.runPaths(home, "run-journaled").workflows, { recursive: true });
    fs.writeFileSync(path.join(runs.runPaths(home, "run-journaled").workflows, "gates-a0.workflow.jsonl"), "");
    const controller = mk("run-controller", { impl_claim: { store: "local", tenant: "local", execution_id: "exec-c", factory: { node_id: "factory-z" } } });
    const out = sp.openPipelineCandidates(home, [bare, stamped, claimed, journaled, controller]);
    assert.deepEqual(out.map((c) => [c.record.run_id, c.factory]).sort(), [["run-claimed", "factory-y"], ["run-controller", "factory-z"], ["run-journaled", null], ["run-stamped", "factory-x"]]);
    assert.ok(out.every((c) => c.projection && Array.isArray(c.projection.stages)));
    assert.equal(out.find((c) => c.record.run_id === "run-claimed").lease.worker, "w");
    // The bridge: a run a dead gate-armed worker's status file names (`owedBy`)
    // is a candidate under that worker's factory even with none of the above —
    // a record dispatched before the `gate_factory` stamp existed.
    const bridged = sp.openPipelineCandidates(home, [bare], { owedBy: new Map([["run-bare", "factory-old"]]) });
    assert.deepEqual(bridged.map((c) => [c.record.run_id, c.factory]), [["run-bare", "factory-old"]]);
    assert.deepEqual(sp.openPipelineCandidates(home, [bare], { owedBy: new Map([["run-other", "factory-old"]]) }), [], "a map that does not name the run admits nothing");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// task-spor-fold-gate-and-integration-into-one-workflow: the lease carries the
// attempt's identity, renews by token, and a present-but-null `own` is refused.
test("the lease is the attempt: pipelineAttempt reads the claim's attempt (the record's legacy count only when never claimed), regated_at marks the reopen, renewPipeline renews by token, and stampGateState refuses `own: null` at runtime", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-lease-attempt-"));
  const RUN = "run-lease-attempt";
  const file = runs.runPaths(home, RUN).record;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  runs.atomicJson(file, { run_id: RUN, node_id: "task-demo", gate_regate_count: 3 });
  const record = runs.readJson(file);
  assert.equal(sp.pipelineAttempt(record, null), 3, "never claimed: the legacy record field");
  const t0 = Date.parse("2026-10-04T12:00:00.000Z");
  const claim = runs.claimPipeline(home, RUN, { workerId: "w1", nowMs: () => t0 });
  assert.equal(claim.ok, true, claim.refused);
  assert.equal(claim.lease.attempt, 3, "the first claim carries the attempt it found");
  assert.equal(claim.lease.regated_at, null);
  assert.equal(sp.pipelineAttempt(runs.readJson(file), claim.lease), 3);
  // Renew by token: the holder's token renews, a stranger's does not, and the
  // worker-id arm still works.
  assert.equal(runs.renewPipeline(home, RUN, { token: "stranger", nowMs: () => t0 + 1000 }).ok, false);
  const renewed = runs.renewPipeline(home, RUN, { token: claim.token, nowMs: () => t0 + 1000 });
  assert.equal(renewed.ok, true);
  assert.equal(renewed.lease.expires_at, new Date(t0 + 1000 + sp.PIPELINE_LEASE_TTL_MS).toISOString());
  assert.equal(runs.renewPipeline(home, RUN, { workerId: "w1", token: claim.token, nowMs: () => t0 + 2000 }).ok, true);
  // A reopen opens attempt 4 ON THE LEASE; the record's count is untouched.
  runs.stampGateState(home, RUN, { gate_state: "failed", gate_settle_id: claim.token }, { own: claim.token });
  const re = runs.claimPipeline(home, RUN, { workerId: "w1", nowMs: () => t0 + 5000, now: () => new Date(t0 + 5000).toISOString(), reopen: { settleId: claim.token, regateCount: 3, state: "failed" } });
  assert.equal(re.ok, true, re.refused);
  assert.equal(re.lease.attempt, 4);
  assert.equal(re.lease.regated_at, new Date(t0 + 5000).toISOString());
  assert.equal(re.record.gate_regate_count, 3, "never written again");
  assert.equal(re.record.gate_regated_at, undefined);
  assert.equal(sp.pipelineAttempt(re.record, re.lease), 4);
  // A reopen whose regateCount is stale against the LEASE is refused.
  runs.stampGateState(home, RUN, { gate_state: "failed", gate_settle_id: re.token }, { own: re.token });
  assert.equal(runs.claimPipeline(home, RUN, { workerId: "w1", reopen: { settleId: re.token, regateCount: 3, state: "failed" } }).refused, "the prior judgement changed before re-gate could claim it");
  // `own: null` is refused outright — not read as the unowned door.
  assert.equal(runs.stampGateState(home, RUN, { gate_fix_run_id: "x" }, { own: null }), null);
  const unowned = runs.stampGateState(home, RUN, { gate_fix_run_id: "x" }, { own: undefined });
  assert.equal(unowned && unowned.gate_fix_run_id, undefined, "an explicit undefined is the unowned door, which declines a settled, claimed record and hands it back as read");
  assert.equal(runs.readJson(file).gate_fix_run_id, undefined);
  fs.rmSync(home, { recursive: true, force: true });
});
