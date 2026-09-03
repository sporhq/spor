// The GATE PIPELINE (task-spor-work-gate-pipeline) — the enforcement layer
// `spor work` runs between a claim and the item counting as done. Four layers,
// each with its own oracle:
//
//   1. the PIPELINE (lib/shell/gate-runner.js) driven with fakes: all three gate
//      kinds, inline and referenced, the fix-cycle loop, the cycle-cap
//      escalation, the graph fact every outcome leaves behind, and the
//      DEMOTION a refusal writes (§10.7 — a refused claim must stop reading
//      done everywhere, not just in this box's cooldown map);
//   2. the COMMAND GATE's git plumbing against a REAL throwaway repo — the one
//      test that has to be real, because the claim being made is "the suite that
//      runs is the trusted ref's copy, never the implementer branch's";
//   3. the LOOP's slot accounting around a gate pipeline — including that a
//      gating item is out of candidate selection, and that a pipeline a dead
//      worker abandoned is RESUMED rather than lost (§10.8) — plus the standing
//      guarantee that a worker with no factory behaves exactly as it did before;
//   4. the CLI end to end in a scratch graph home — a declared factory refuses
//      to start a worker if it does not validate, and a real dispatch's gate
//      outcome lands in the graph as a node.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync, execFileSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const gates = require("../lib/kernel/gates.js");
const gateRunner = require("../lib/shell/gate-runner.js");
const workLoop = require("../lib/shell/work-loop.js");
const { writeSpawnableNodeStub, pathWithOnlyGitAndNode } = require("./helpers/portable");

// ------------------------------------------------------------ the pipeline --

function factoryOf(payload, gateNodes = new Map()) {
  const body = ["```json", JSON.stringify(payload), "```"].join("\n");
  const { factory, errors } = gates.parseFactory(body, { id: "factory-test", gateNodes });
  assert.deepStrictEqual(errors, [], errors.join("; "));
  return factory;
}

const BASE = {
  factory: "test",
  trusted_ref: "main",
  protected_paths: ["test/**"],
  test_lane_profile: "profile-test-writer",
  risk_classes: { "touches:auth": ["lib/auth.js"] },
};

// A fake world: what the diff says, what the suite does, what a review answers,
// what the graph accepts. Every write is captured so the tests can assert on
// the FACTS, which is the deliverable, not just on the verdict.
function fakes({ changed = ["lib/x.js"], suite = () => ({ ok: true }), review = () => ({ ok: true, text: '```json\n{"verdict":"pass"}\n```' }), fix = () => ({ ok: true }), approval = () => ({ state: "approved", by: "person-a" }), demote = () => ({ ok: true, demoted: true, note: "task-demo rolled back done -> open" }), writes = null } = {}) {
  const seen = { facts: [], lane: [], human: [], escalations: [], demotions: [], suites: [], reviews: [], fixes: [], approvals: 0, slept: 0 };
  let clock = 1_700_000_000_000;
  const deps = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      seen.slept += 1;
    },
    changedPaths: async () => (changed === null ? { ok: false, reason: "unreadable tree" } : { ok: true, paths: changed }),
    runSuite: async (args) => {
      seen.suites.push(args.gate.id);
      return suite(args, seen);
    },
    review: async (args) => {
      seen.reviews.push({ gate: args.gate.id, cycle: args.cycle });
      return review(args, seen);
    },
    fix: async (args) => {
      seen.fixes.push({ gate: args.gate.id, cycle: args.cycle, findings: args.findings });
      return fix(args, seen);
    },
    recordFact: async ({ id, markdown }) => {
      seen.facts.push({ id, markdown });
      return writes === "refuse" ? { ok: false, reason: "the graph refused the write" } : { ok: true, id };
    },
    fileTestLaneItem: async (args) => {
      seen.lane.push(args);
      return { ok: true, id: "task-test-lane-x" };
    },
    fileHumanItem: async (args) => {
      seen.human.push(args);
      return { ok: true, id: "task-approve-x" };
    },
    checkApproval: async () => {
      seen.approvals += 1;
      return approval(seen);
    },
    escalate: async (args) => {
      seen.escalations.push(args);
      return { ok: true, id: `task-gate-${args.gate.id}` };
    },
    demote: async (args) => {
      seen.demotions.push(args);
      return demote(args, seen);
    },
  };
  return { deps, seen };
}

const ITEM = { node_id: "task-demo", run_id: "run-abcdef12", project: "demo" };

test("a passing pipeline runs its gates IN ORDER and records a graph fact for each", async () => {
  const factory = factoryOf({
    ...BASE,
    gates: [
      { id: "acceptance", kind: "command", command: "npm test" },
      { id: "review", kind: "agent-review", profile: "profile-review" },
      { id: "security", kind: "human", risk: ["touches:auth"] },
    ],
  });
  const { deps, seen } = fakes({ changed: ["lib/x.js"] });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(res.gates.map((g) => [g.gate, g.verdict]), [
    ["acceptance", "passed"],
    ["review", "passed"],
    // Not armed: the change touched no declared risk class.
    ["security", "skipped"],
  ]);
  assert.strictEqual(seen.facts.length, 3, "every gate outcome is a graph fact");
  for (const f of seen.facts) {
    assert.match(f.markdown, /type: artifact/);
    assert.match(f.markdown, /- \{type: relates-to, to: task-demo\}/, "the fact is linked to the work item");
    assert.doesNotMatch(f.markdown, /type: resolves/, "a gate outcome never resolves anything");
  }
  // Readable prefix, whole-tuple identity: the gate id is truncated at 24 chars
  // in the prefix, so the hash is what actually keeps two gates' facts apart.
  for (const [i, gate] of ["acceptance", "review", "security"].entries()) {
    assert.match(seen.facts[i].id, new RegExp(`^art-gate-${gate}-demo-runabcde-[0-9a-f]{8}$`));
  }
  assert.strictEqual(new Set(seen.facts.map((f) => f.id)).size, 3, "one distinct fact per gate");
  assert.strictEqual(seen.human.length, 0, "an unarmed human gate files nothing");
});

test("a REFERENCED shareable gate node runs exactly like the same gate written inline", async () => {
  const shared = { id: "review", kind: "agent-review", profile: "profile-review" };
  const run = async (gatesList, gateNodes) => {
    const factory = factoryOf({ ...BASE, gates: gatesList }, gateNodes);
    const { deps, seen } = fakes();
    const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
    return { res, seen };
  };
  const inline = await run([{ ...shared }]);
  const referenced = await run([{ ref: "gate-review" }], new Map([["gate-review", shared]]));
  assert.strictEqual(inline.res.state, referenced.res.state);
  assert.deepStrictEqual(inline.seen.reviews, referenced.seen.reviews);
  assert.deepStrictEqual(
    inline.res.gates.map((g) => [g.gate, g.verdict]),
    referenced.res.gates.map((g) => [g.gate, g.verdict])
  );
  // The one visible difference is provenance, recorded on the fact.
  assert.match(referenced.seen.facts[0].markdown, /shared gate node/);
  assert.doesNotMatch(inline.seen.facts[0].markdown, /shared gate node/);
});

test("a command gate whose suite fails escalates to a human item, and the fact carries the evidence", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test" }] });
  const { deps, seen } = fakes({ suite: () => ({ ok: false, code: 1, output: "1 failing\n  the sync worker drops records\n" }) });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(res.escalated_to, "task-gate-acceptance");
  assert.strictEqual(seen.escalations.length, 1);
  assert.strictEqual(seen.fixes.length, 0, "cycles default to 0 — one failure escalates");
  assert.match(seen.facts[0].markdown, /the sync worker drops records/);
  assert.match(seen.facts[0].markdown, /Escalated to task-gate-acceptance/);
});

test("an implementer branch that edits a protected test path fails the gate CLOSED — unrun, unretried, routed to the test lane", async () => {
  const factory = factoryOf({
    ...BASE,
    gates: [{ id: "acceptance", kind: "command", command: "npm test", cycles: 3 }],
  });
  const { deps, seen } = fakes({ changed: ["lib/x.js", "test/x.test.js"] });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(seen.suites.length, 0, "the suite is never run from a branch that edits it");
  assert.strictEqual(seen.fixes.length, 0, "a protected-path violation is not something a fix cycle may retry");
  assert.strictEqual(seen.lane.length, 1);
  assert.deepStrictEqual(seen.lane[0].paths, ["test/x.test.js"]);
  assert.strictEqual(seen.lane[0].profile, "profile-test-writer", "the test change routes to a DIFFERENT profile");
  assert.strictEqual(res.gates[0].verdict, "fail-closed");
  assert.strictEqual(res.gates[0].escalated_to, "task-test-lane-x");
});

// A demonstrated blocking finding — the only kind that fails the gate under
// task-spor-review-gate-stateful-bounded's severity floor.
const BLOCKING = (summary, extra = "") => `{"severity":"blocking","file":"lib/x.js","summary":"${summary}","evidence":"node -e 'require(\\"./lib/x.js\\")' throws"${extra}}`;
const changesRequested = `\`\`\`json\n{"verdict":"changes_requested","findings":[${BLOCKING("off by one")}]}\n\`\`\``;

test("an agent-review gate loops fix cycles up to its cap, then escalates by filing a human queue item", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "review", kind: "agent-review", profile: "profile-review", cycles: 2 }] });
  // A reviewer that CONFIRMS the prior finding still open every cycle.
  const { deps, seen } = fakes({
    review: ({ prior }) => ({
      ok: true,
      text: prior.length
        ? `\`\`\`json\n{"verdict":"changes_requested","prior":[${prior.map((p) => `{"id":"${p.id}","status":"open"}`).join(",")}],"findings":[]}\n\`\`\``
        : changesRequested,
    }),
  });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(seen.reviews.length, 3, "the first attempt plus two fix cycles");
  assert.deepStrictEqual(seen.reviews.map((r) => r.cycle), [0, 1, 2]);
  assert.strictEqual(seen.fixes.length, 2, "exactly the declared cap");
  assert.deepStrictEqual(seen.fixes[0].findings.map((f) => f.summary), ["off by one"], "the fix cycle is handed the findings");
  assert.deepStrictEqual(seen.fixes[1].findings.map((f) => f.id), ["F1"], "the second fix cycle is handed the SAME finding by its ledger id");
  assert.strictEqual(seen.escalations.length, 1);
  assert.strictEqual(seen.escalations[0].attempts.length, 3);
  assert.deepStrictEqual(seen.escalations[0].ledger.map((e) => [e.id, e.status]), [["F1", "open"]], "the escalation carries the ledger");
  assert.strictEqual(seen.facts.length, 1, "one fact per gate, carrying the cycle history");
  assert.match(seen.facts[0].markdown, /Cycles \(3 attempts: the initial one plus 2 fix cycles, cap 2\):/);
  assert.match(seen.facts[0].markdown, /2\. after fix cycle 1: failed/);
  assert.match(seen.facts[0].markdown, /Finding ledger:\n\nF1 \[blocking\] OPEN since cycle 0 — lib\/x\.js — off by one/);
});

// The acceptance line of task-spor-review-gate-stateful-bounded: `cycles: 3`
// is exactly three fix dispatches. The reviews number four (the initial one
// plus one after each fix), and the record says so in fix cycles rather than
// reading as "4 attempts, cap 3".
test("`cycles: 3` produces exactly three fix dispatches — four reviews, counted as fix cycles on the record", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "review", kind: "agent-review", profile: "profile-review", cycles: 3 }] });
  const { deps, seen } = fakes({
    review: ({ prior }) => ({
      ok: true,
      text: prior.length
        ? `\`\`\`json\n{"verdict":"changes_requested","prior":[${prior.map((p) => `{"id":"${p.id}","status":"open"}`).join(",")}],"findings":[]}\n\`\`\``
        : changesRequested,
    }),
  });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(seen.fixes.length, 3, "exactly three fix dispatches");
  assert.strictEqual(seen.reviews.length, 4);
  assert.match(seen.facts[0].markdown, /4 attempts: the initial one plus 3 fix cycles, cap 3/);
});

test("a fix cycle that lands makes the gate pass, and nothing is escalated — the reviewer is handed the prior set and the fix", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "review", kind: "agent-review", profile: "profile-review", cycles: 2 }] });
  let call = 0;
  const handed = [];
  const { deps, seen } = fakes({
    review: ({ prior, fix, ledger }) => {
      call += 1;
      handed.push({ prior, fix, ledger });
      return { ok: true, text: call === 1 ? changesRequested : '```json\n{"verdict":"pass","prior":[{"id":"F1","status":"resolved","note":"the bound is now exclusive"}]}\n```' };
    },
    fix: () => ({ ok: true, runId: "run-fix-1" }),
  });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "passed");
  assert.strictEqual(seen.fixes.length, 1);
  assert.strictEqual(seen.escalations.length, 0);
  assert.deepStrictEqual(handed[0].prior, [], "the initial review has no prior set");
  assert.strictEqual(handed[0].fix, null);
  assert.deepStrictEqual(handed[1].prior.map((p) => [p.id, p.summary]), [["F1", "off by one"]], "review 2 is handed review 1's open finding by id");
  assert.strictEqual(handed[1].fix.runId, "run-fix-1", "…and the fix cycle that was dispatched at it");
  assert.strictEqual(handed[1].fix.cycle, 0);
  assert.match(seen.facts[0].markdown, /F1 \[blocking\] resolved at cycle 1 — lib\/x\.js — off by one \(the bound is now exclusive\)/, "the passing fact records what cleared it");
});

// The bounded half: a memoryless reviewer that ignores the prior set does not
// get to move the goalposts. Its verdict is unreadable and counts as
// changes_requested for the PRIOR set only — the fixer is sent back at F1,
// never at the fresh finding, and the fresh finding never reaches the ledger.
test("a review that ignores a prior finding is unreadable and re-dispatches the fix at the PRIOR set only — a new finding it raised is never admitted", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "review", kind: "agent-review", profile: "profile-review", cycles: 1 }] });
  let call = 0;
  const { deps, seen } = fakes({
    review: () => {
      call += 1;
      return {
        ok: true,
        text: call === 1 ? changesRequested : `\`\`\`json\n{"verdict":"changes_requested","findings":[${BLOCKING("a brand new goalpost", ',"introduced_by_fix":true')}]}\n\`\`\``,
      };
    },
  });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.match(res.reason, /ignored prior finding F1/);
  assert.deepStrictEqual(seen.escalations[0].findings.map((f) => f.id), ["F1"], "the escalation carries the prior set, not the goalpost");
  assert.deepStrictEqual(seen.escalations[0].ledger.map((e) => e.summary), ["off by one"], "the goalpost never reached the ledger");
  assert.match(seen.facts[0].markdown, /ignored prior finding F1 \(neither cleared nor confirmed\)/);
});

// Replay of the four real codex reports from dispatched run a4f90513 (gate
// adversarial-review on issue-spor-connection-deletion-update-toctou): under the
// memoryless prompt each cycle raised NEW blocking findings and the escalation
// carried four, none of them the two the fixer had been sent to fix.
//
// The reports predate the protocol, so they carry no structured `evidence`
// field: the reviewer's demonstration, where it made one, is in its PROSE
// ("I reproduced this: …", "a concurrency probe reproduced …"). The replay
// lifts exactly that — the reviewer's own reproduction sentence, for exactly
// the findings whose prose claims one — into `evidence`, by position, and
// stamps NOTHING on a finding the reviewer only argued from the code. Nothing
// else about any report is touched. So what the protocol sees is what the
// reviewer actually did, and the acceptance line of
// task-spor-review-gate-stateful-bounded is exercised as stated: at most ONE
// escalation-worthy unresolved blocking finding, and exactly three fix
// dispatches for `cycles: 3`.
function liftProseEvidence(report) {
  // The prose findings, in order: "- **Blocking — …**" / "1. **Blocking — …**"
  // paragraphs. A paragraph demonstrates its finding iff it says so.
  const paragraphs = report.split(/\n\s*\n/).filter((para) => /^\s*(?:-|\d+\.)\s+\*\*Blocking\b/i.test(para));
  const demonstrated = paragraphs.map((para) => {
    const m = para.match(/[^.]*\breproduc(?:ed|tion)\b[^.]*\./i);
    return m ? m[0].replace(/\s+/g, " ").trim() : null;
  });
  const fence = report.match(/```json\n([\s\S]*?)\n```/);
  const obj = JSON.parse(fence[1]);
  let i = 0;
  for (const f of obj.findings) {
    if (f.severity !== "blocking") continue;
    const ev = demonstrated[i++];
    if (ev) f.evidence = ev;
  }
  return report.slice(0, fence.index) + "```json\n" + JSON.stringify(obj) + "\n```" + report.slice(fence.index + fence[0].length);
}

test("replaying run a4f90513's four codex reports through the stateful protocol bounds the escalation to ONE demonstrated finding", async () => {
  const dir = path.join(__dirname, "fixtures", "review-replay");
  const reports = [0, 1, 2, 3].map((i) => fs.readFileSync(path.join(dir, `a4f90513-review-${i}.md`), "utf8"));
  const texts = reports.map(liftProseEvidence);
  // What the lift did, made explicit so the test cannot quietly fabricate: the
  // initial review demonstrated ONE of its two blocking findings (the
  // revocation-before-CAS one; the ABA finding is argued from the code alone).
  const initial = JSON.parse(texts[0].match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.deepStrictEqual(initial.findings.map((f) => !!f.evidence), [true, false]);
  assert.match(initial.findings[0].evidence, /^I reproduced this: the replacement survived/);
  assert.strictEqual(reports[0].includes('"evidence"'), false, "the fixture itself carries no evidence field");

  const factory = factoryOf({ ...BASE, gates: [{ id: "adversarial-review", kind: "agent-review", profile: "profile-codex-sol", cycles: 3 }] });
  let call = 0;
  const { deps, seen } = fakes({ review: () => ({ ok: true, text: texts[call++] }) });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(seen.reviews.length, 4);
  assert.strictEqual(seen.fixes.length, 3, "cycles: 3 — exactly three fix dispatches");
  assert.deepStrictEqual(seen.reviews.map((r) => r.cycle), [0, 1, 2, 3]);

  const escalated = seen.escalations[0];
  const unresolved = escalated.findings.filter((f) => f.blocking);
  assert.strictEqual(unresolved.length, 1, "at most one escalation-worthy unresolved blocking finding");
  assert.strictEqual(unresolved[0].id, "F1");
  assert.match(unresolved[0].summary, /revocation cascade runs before compare-and-delete/);
  assert.deepStrictEqual(
    escalated.ledger.map((e) => [e.id, e.status]),
    [["F1", "open"], ["F2", "advisory"]],
    "cycle 0's undemonstrated finding is on the record as advisory; nothing from cycles 1..3 is admitted (none answered the prior set)"
  );
  for (const fix of seen.fixes) {
    assert.deepStrictEqual(fix.findings.filter((f) => f.blocking !== false).map((f) => f.id), ["F1"], "every fix cycle is sent back at the SAME demonstrated finding");
  }
  assert.match(res.reason, /ignored prior finding F1/, "the later reports never answered F1 — that is why they were unreadable");
  assert.match(seen.facts[0].markdown, /4 attempts: the initial one plus 3 fix cycles, cap 3/);
  assert.match(seen.facts[0].markdown, /F1 \[blocking\] OPEN since cycle 0 — server\/rest-fastify\.ts/);
  assert.match(seen.facts[0].markdown, /F2 \[blocking\] advisory \(cycle 0\) — server\/rest-fastify\.ts/);
  assert.doesNotMatch(seen.facts[0].markdown, /authorization or approved device codes/, "cycle 3's new finding is nowhere on the record");
  assert.doesNotMatch(seen.facts[0].markdown, /non-renewable 30-second-stale file lock/, "nor is cycle 1's");
});

// Review finding 1 on the first cut: the ledger and the cycle count lived only
// in the worker process, so a resumed pipeline (§10.8) restarted every review
// gate from cycle 0 with an empty ledger — prior findings forgotten, and the
// declared `cycles` cap granted afresh per interruption. The runner now saves
// its per-gate progress through `saveGateProgress` after every step that
// changes it and seeds from `loadGateProgress`; the bound holds ACROSS the
// interruption: the fix cycles a killed worker dispatched still count.
test("a resumed pipeline carries the finding ledger and the fix-cycle count, so the cap holds across the interruption", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "review", kind: "agent-review", profile: "profile-review", cycles: 3 }] });
  const confirming = ({ prior }) => ({
    ok: true,
    text: prior.length
      ? `\`\`\`json\n{"verdict":"changes_requested","prior":[${prior.map((p) => `{"id":"${p.id}","status":"open"}`).join(",")}],"findings":[]}\n\`\`\``
      : changesRequested,
  });

  // Worker A runs the gate and records what it saves, in order.
  const saves = [];
  const a = fakes({ review: confirming, fix: () => ({ ok: true, runId: "run-fix-a" }) });
  a.deps.saveGateProgress = async ({ gate, progress }) => saves.push({ gate: gate.id, progress: JSON.parse(JSON.stringify(progress)) });
  await gateRunner.runGatePipeline({ item: ITEM, factory, deps: a.deps });
  assert.strictEqual(a.seen.fixes.length, 3);
  // The count is charged the moment the fix's LAUNCH is durably known (the
  // fake fix dep reports none, so at its completion) — a worker killed while
  // it waits on the fix must resume AFTER it, not dispatch it twice. The save
  // that precedes the second fix records it PENDING (`dispatched: false`)
  // under the unchanged count of one, so a crash before the launch resumes
  // INTO that fix rather than past it (review finding 2 on the second cut).
  const beforeSecondFix = saves.find((s) => s.progress.fixes === 1 && s.progress.lastFix && s.progress.lastFix.dispatched === false && s.progress.lastFix.cycle === 1);
  assert.ok(beforeSecondFix, "progress is saved with the fix pending before the fix is dispatched");
  assert.deepStrictEqual(beforeSecondFix.progress.ledger.map((e) => [e.id, e.status]), [["F1", "open"]]);
  assert.strictEqual(beforeSecondFix.progress.attempts.length, 2, "two reviews had run");
  const afterSecondFix = saves.find((s) => s.progress.fixes === 2 && s.progress.lastFix && s.progress.lastFix.dispatched === true);
  assert.ok(afterSecondFix, "…and charged once the fix ran");
  assert.strictEqual(afterSecondFix.progress.lastFix.runId, "run-fix-a");

  // Worker B adopts the orphan as if A died waiting on its second fix cycle
  // (the fix launched: the snapshot after it).
  const handed = [];
  const b = fakes({
    review: (args) => {
      handed.push({ cycle: args.cycle, prior: args.prior, fix: args.fix });
      return confirming(args);
    },
    fix: () => ({ ok: true, runId: "run-fix-b" }),
  });
  b.deps.loadGateProgress = async () => afterSecondFix.progress;
  const resumedSaves = [];
  b.deps.saveGateProgress = async ({ progress }) => resumedSaves.push(JSON.parse(JSON.stringify(progress)));
  const logs = [];
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: b.deps, log: (l) => logs.push(l) });
  assert.strictEqual(res.state, "failed");
  assert.deepStrictEqual(b.seen.reviews.map((r) => r.cycle), [2, 3], "B resumes at the review AFTER A's second fix");
  assert.strictEqual(b.seen.fixes.length, 1, "A dispatched two fixes, B dispatches the third and last — three in total, the cap");
  assert.deepStrictEqual(handed[0].prior.map((p) => p.id), ["F1"], "the prior set survived the interruption");
  assert.strictEqual(handed[0].fix.cycle, 1, "…and so did the record of the fix that was in flight");
  assert.strictEqual(b.seen.escalations.length, 1);
  assert.strictEqual(b.seen.escalations[0].attempts.length, 4, "the attempt history counts A's two reviews plus B's two");
  assert.deepStrictEqual(b.seen.escalations[0].ledger.map((e) => e.id), ["F1"], "the ledger never reset");
  assert.match(b.seen.facts[0].markdown, /4 attempts: the initial one plus 3 fix cycles, cap 3/);
  assert.ok(logs.some((l) => /resumed on task-demo at fix cycle 2\/3 — 1 ledger finding\(s\) carried/.test(l)), logs.join("\n"));
  assert.ok(resumedSaves.every((p) => p.fixes <= 3));

  // Worker B' adopts the PENDING snapshot instead — A died between deciding on
  // its second fix and launching it. The fix is dispatched (not skipped), no
  // review is re-run for cycle 1, and the cap still holds at three fixes.
  const handedP = [];
  const bp = fakes({
    review: (args) => {
      handedP.push(args.cycle);
      return confirming(args);
    },
    fix: () => ({ ok: true, runId: "run-fix-bp" }),
  });
  bp.deps.loadGateProgress = async () => beforeSecondFix.progress;
  const logsP = [];
  const resP = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: bp.deps, log: (l) => logsP.push(l) });
  assert.strictEqual(resP.state, "failed");
  assert.deepStrictEqual(bp.seen.fixes.map((f) => f.cycle), [1, 2], "the never-launched second fix runs first, then the third");
  assert.deepStrictEqual(bp.seen.fixes[0].findings.map((f) => f.id), ["F1"], "…with the findings the review it followed had decided on");
  assert.deepStrictEqual(bp.seen.reviews.map((r) => r.cycle), [2, 3], "cycle 1's review is not re-run: it already ran");
  assert.strictEqual(bp.seen.escalations[0].attempts.length, 4);
  assert.ok(logsP.some((l) => /the fix for cycle 1 never launched, dispatching it first/.test(l)), logsP.join("\n"));

  // A fix dep that reports its launch (`onLaunch`, as the real one does from
  // cmdDispatch) charges the cycle at that moment, before the long wait.
  const launchSaves = [];
  const l = fakes({
    review: confirming,
    fix: async ({ onLaunch }) => {
      await onLaunch({ runId: "run-fix-l" });
      launchSaves.push(JSON.parse(JSON.stringify(saves2[saves2.length - 1].progress)));
      return { ok: true, runId: "run-fix-l" };
    },
  });
  const saves2 = [];
  l.deps.saveGateProgress = async ({ progress }) => saves2.push({ progress: JSON.parse(JSON.stringify(progress)) });
  await gateRunner.runGatePipeline({ item: ITEM, factory, deps: l.deps });
  assert.deepStrictEqual(launchSaves.map((p) => [p.fixes, p.lastFix.dispatched, p.lastFix.runId]), [[1, true, "run-fix-l"], [2, true, "run-fix-l"], [3, true, "run-fix-l"]]);

  // A snapshot whose review at the resume cycle ran but whose next step was
  // never durably decided (the fold saved, the worker died before the pass or
  // escalation landed) rolls that cycle's fold back and re-runs the review —
  // the redo's findings get fresh ids, never an earlier attempt's (review
  // finding 3 on the second cut).
  const afterReview1 = saves.find((s) => s.progress.fixes === 1 && s.progress.attempts.length === 2);
  const redoSnapshot = JSON.parse(JSON.stringify(afterReview1.progress));
  redoSnapshot.lastFix = { ...redoSnapshot.lastFix, dispatched: true }; // not pending: as if the next step had been a pass/escalation
  const redo = fakes({
    review: ({ prior }) => ({ ok: true, text: `\`\`\`json\n{"verdict":"changes_requested","prior":[${prior.map((p) => `{"id":"${p.id}","status":"open"}`).join(",")}],"findings":[{"severity":"blocking","summary":"the redo's own finding","evidence":"e","introduced_by_fix":true}]}\n\`\`\`` }),
    fix: () => ({ ok: true, runId: "run-fix-redo" }),
  });
  redo.deps.loadGateProgress = async () => redoSnapshot;
  await gateRunner.runGatePipeline({ item: ITEM, factory, deps: redo.deps });
  assert.deepStrictEqual(redo.seen.reviews.map((r) => r.cycle), [1, 2, 3], "the review at cycle 1 is re-run");
  assert.deepStrictEqual(redo.seen.fixes[0].findings.map((f) => [f.id, f.summary]), [["F1", "off by one"], ["F2", "the redo's own finding"]]);
  assert.strictEqual(redo.seen.escalations[0].attempts.length, 4, "the rolled-back attempt is not double counted");

  // A snapshot that already used the whole allowance resumes straight into the
  // escalating review: one more review, no fix.
  const exhausted = saves[saves.length - 1].progress;
  assert.strictEqual(exhausted.fixes, 3);
  const c = fakes({ review: confirming });
  c.deps.loadGateProgress = async () => exhausted;
  const resC = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: c.deps });
  assert.strictEqual(resC.state, "failed");
  assert.strictEqual(c.seen.fixes.length, 0, "no fourth fix cycle, ever");
  assert.deepStrictEqual(c.seen.reviews.map((r) => r.cycle), [3]);

  // The deps are optional: a runner with neither is the in-process behaviour.
  const bare = fakes({ review: confirming });
  await gateRunner.runGatePipeline({ item: ITEM, factory, deps: bare.deps });
  assert.strictEqual(bare.seen.fixes.length, 3);
  // …and a save that throws is logged, never fatal.
  const broken = fakes({ review: confirming });
  broken.deps.saveGateProgress = async () => { throw new Error("disk full"); };
  const brokenLogs = [];
  const resBroken = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: broken.deps, log: (l) => brokenLogs.push(l) });
  assert.strictEqual(resBroken.state, "failed");
  assert.ok(brokenLogs.some((l) => /progress could not be saved \(disk full\)/.test(l)));
});

test("a review that cannot be read, dispatched or reported is a FAILURE — never a pass", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "review", kind: "agent-review", profile: "profile-review" }] });
  for (const review of [
    () => ({ ok: true, text: "looks great to me" }), // no structured verdict
    () => ({ ok: false, reason: "the profile is unsatisfiable here" }), // never ran
    () => {
      throw new Error("boom");
    },
  ]) {
    const { deps } = fakes({ review });
    const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
    assert.strictEqual(res.state, "failed");
  }
});

test("a human gate files an approval item, blocks on it, and takes the person's answer as the verdict", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "security", kind: "human", risk: ["touches:auth"] }] });

  const approved = fakes({ changed: ["lib/auth.js"], approval: () => ({ state: "approved", by: "person-a" }) });
  let res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: approved.deps });
  assert.strictEqual(res.state, "passed");
  assert.strictEqual(approved.seen.human.length, 1);
  assert.deepStrictEqual(approved.seen.human[0].classes.map((c) => c.class), ["touches:auth"]);

  const refused = fakes({ changed: ["lib/auth.js"], approval: () => ({ state: "rejected", by: "person-a" }) });
  res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: refused.deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(refused.seen.escalations.length, 0, "a refused approval IS the human item — no second one is filed");

  // Unanswered: the runner waits, bounded, and reports BLOCKED rather than
  // deciding on the person's behalf.
  const pending = fakes({ changed: ["lib/auth.js"], approval: () => ({ state: "pending" }) });
  const timed = factoryOf({
    ...BASE,
    gates: [{ id: "security", kind: "human", risk: ["touches:auth"], approval_timeout_ms: 10000, poll_ms: 1000 }],
  });
  res = await gateRunner.runGatePipeline({ item: ITEM, factory: timed, deps: pending.deps });
  assert.strictEqual(res.state, "blocked");
  assert.strictEqual(res.escalated_to, "task-approve-x");
  assert.ok(pending.seen.approvals > 1, "it polls the approval item");
  assert.ok(pending.seen.slept <= 11, "and the wait is bounded");
});

test("a gate ordered after a failed one never runs — the pipeline stops at the first refusal", async () => {
  const factory = factoryOf({
    ...BASE,
    gates: [
      { id: "acceptance", kind: "command", command: "npm test" },
      { id: "review", kind: "agent-review", profile: "profile-review" },
    ],
  });
  const { deps, seen } = fakes({ suite: () => ({ ok: false, code: 1, output: "boom" }) });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(seen.reviews.length, 0);
});

test("an unreadable change set fails every path-dependent gate closed", async () => {
  // Both kinds that read the diff, each on its own: the command gate (which
  // would otherwise run a suite over a tree it cannot describe) and the human
  // gate (whose risk classes are path predicates — "assume unarmed" is the
  // fail-OPEN reading on the one kind that exists for risky changes).
  for (const gate of [
    { id: "acceptance", kind: "command", command: "npm test" },
    { id: "security", kind: "human", risk: ["touches:auth"] },
  ]) {
    const factory = factoryOf({ ...BASE, gates: [gate] });
    const { deps, seen } = fakes({ changed: null });
    const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
    assert.strictEqual(res.state, "failed", `${gate.kind} must fail closed on an unreadable diff`);
    assert.strictEqual(seen.suites.length, 0);
    assert.strictEqual(seen.human.length, 0, "and no approval is filed for a change nobody could describe");
    assert.match(res.reason, /unreadable tree/);
  }
});

test("a graph that refuses the fact write does not change the verdict — the enforcement is not the bookkeeping", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test" }] });
  const { deps } = fakes({ writes: "refuse" });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(res.facts, [], "and it does not claim a fact it could not write");
});

// ------------------------------------------------ a refusal DEMOTES the item --
// The gate necessarily runs AFTER the run wrote its resolver, so a refused
// claim is one the graph is already carrying as finished. A machine-local
// cooldown does not touch that — every other reader would go on calling it done
// — so the refusal has to become graph state.

test("a FAILED gate demotes the work item on the graph, naming the escalation that now blocks it", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test", cycles: 0 }] });
  const { deps, seen } = fakes({ suite: () => ({ ok: false, code: 1, output: "1 failing" }) });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(seen.demotions.length, 1, "a refusal that lives only in this box's cooldown map is not enforcement");
  assert.strictEqual(seen.demotions[0].item.node_id, "task-demo");
  assert.strictEqual(seen.demotions[0].state, "failed");
  assert.strictEqual(
    seen.demotions[0].blockerId,
    "task-gate-acceptance",
    "the demotion names the escalation, so it is filed BEFORE the item is demoted — never a demoted item with nothing to point at"
  );
  assert.strictEqual(res.demoted, true);
  assert.strictEqual(res.demote_reason, null);
  // And the gate's own fact records the demotion, so the graph carries the
  // whole story rather than half of it.
  assert.match(seen.facts[0].markdown, /Demotion: task-demo rolled back done -> open/);
});

test("a BLOCKED human gate demotes too — an unanswered approval is not an approval", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "security", kind: "human", risk: ["touches:auth"], approval_timeout_ms: 0 }] });
  const { deps, seen } = fakes({ changed: ["lib/auth.js"], approval: () => ({ state: "pending" }) });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "blocked");
  assert.strictEqual(seen.demotions.length, 1);
  assert.strictEqual(seen.demotions[0].state, "blocked");
  assert.strictEqual(seen.demotions[0].blockerId, "task-approve-x", "the approval item is the blocker");
  assert.strictEqual(res.demoted, true);
});

test("a PASSING pipeline demotes nothing — a gate records what was enforced, it never retires or reopens", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test" }] });
  const { deps, seen } = fakes();
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(seen.demotions, []);
  assert.strictEqual(res.demoted, undefined, "and a pass carries no demotion dimension at all");
});

test("a demotion the graph refuses is REPORTED, not swallowed — and never turns a refusal into a pass", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test", cycles: 0 }] });
  const { deps, seen } = fakes({
    suite: () => ({ ok: false, code: 1 }),
    demote: () => ({ ok: false, reason: "offline — could not reach server" }),
  });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed", "the enforcement is the verdict, not the bookkeeping");
  assert.strictEqual(res.demoted, false);
  assert.match(res.demote_reason, /offline/);
  assert.match(seen.facts[0].markdown, /Demotion: the item could not be demoted on the graph \(offline/);
});

test("an escalation that could not be filed still demotes, and the note never implies a blocker that does not exist", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test", cycles: 0 }] });
  const { deps, seen } = fakes({
    suite: () => ({ ok: false, code: 1 }),
    demote: ({ blockerId }) => ({ ok: true, demoted: true, note: blockerId ? `blocked by ${blockerId}` : "nothing blocks task-demo" }),
  });
  deps.escalate = async () => ({ ok: false, reason: "the graph refused the write" });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(res.escalated_to, null, "nothing was filed");
  assert.strictEqual(seen.demotions.length, 1, "the status rollback is still worth doing without a blocker");
  assert.strictEqual(seen.demotions[0].blockerId, null);
  assert.match(seen.facts[0].markdown, /Demotion: nothing blocks task-demo/);
});

test("a pipeline with no demote dep at all still settles — the step is optional, like every other write", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test", cycles: 0 }] });
  const { deps } = fakes({ suite: () => ({ ok: false, code: 1 }) });
  delete deps.demote;
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(res.demoted, false);
});

// ------------------------------------------------ the command gate, for real --

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// A repo whose `test/acceptance.js` is a real (tiny) acceptance suite, and a
// branch that BREAKS the behavior it checks while rewriting the suite to say so
// anyway — the exact shape a command gate exists to catch.
function repoWithBranch({ weakenTest = true, regress = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "Test");
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".spor"), "project: demo\n");
  fs.writeFileSync(path.join(dir, "lib", "add.js"), "module.exports = (a, b) => a + b;\n");
  fs.writeFileSync(
    path.join(dir, "test", "acceptance.js"),
    'const add = require("../lib/add.js");\nif (add(2, 3) !== 5) { console.error("add is broken"); process.exit(1); }\n'
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "trusted");
  git(dir, "checkout", "-q", "-b", "impl");
  if (regress) fs.writeFileSync(path.join(dir, "lib", "add.js"), "module.exports = (a, b) => a * b;\n"); // the regression
  else fs.writeFileSync(path.join(dir, "lib", "sub.js"), "module.exports = (a, b) => a - b;\n"); // benign work
  if (weakenTest) {
    // ...and the implementer "fixes" the suite that would have caught it.
    fs.writeFileSync(path.join(dir, "test", "acceptance.js"), "process.exit(0);\n");
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "implementer work");
  return dir;
}

test("gateChangeSet reads the committed change against the trusted ref, and refuses a dirty tree", () => {
  const dir = repoWithBranch();
  const change = gateRunner.gateChangeSet({ cwd: dir }, "main");
  assert.strictEqual(change.ok, true, change.reason);
  assert.deepStrictEqual(change.paths.sort(), ["lib/add.js", "test/acceptance.js"]);
  assert.strictEqual(change.head, git(dir, "rev-parse", "HEAD").trim());

  fs.writeFileSync(path.join(dir, "lib", "add.js"), "module.exports = () => 0;\n");
  const dirty = gateRunner.gateChangeSet({ cwd: dir }, "main");
  assert.strictEqual(dirty.ok, false);
  assert.match(dirty.reason, /uncommitted/);

  assert.strictEqual(gateRunner.gateChangeSet({ cwd: "/nonexistent/xyz" }, "main").ok, false);
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-plain-"));
  assert.strictEqual(gateRunner.gateChangeSet({ cwd: notARepo }, "main").ok, false);
  const missingRef = gateRunner.gateChangeSet({ cwd: repoWithBranch() }, "no-such-ref");
  assert.strictEqual(missingRef.ok, false);
  assert.match(missingRef.reason, /does not resolve/);
});

test("the suite that runs is the TRUSTED ref's copy — an implementer-branch test edit cannot pass its own gate", async () => {
  const dir = repoWithBranch({ weakenTest: true });
  const change = gateRunner.gateChangeSet({ cwd: dir }, "main");
  const gate = { id: "acceptance", command: `"${process.execPath}" test/acceptance.js`, timeoutMs: 60000, dir: "" };

  // 1. The branch's own copy of the suite passes — that is the whole problem.
  const branchRun = await gateRunner.runGateCommand(gate, dir);
  assert.strictEqual(branchRun.ok, true, "the weakened suite passes on the branch, as designed");

  // 2. The gate's tree takes the branch's SOURCE and the trusted ref's TESTS,
  //    and the regression is caught.
  const tree = gateRunner.prepareGateTree(change, { trustedRef: "main", protectedPaths: ["test/**"] });
  assert.strictEqual(tree.ok, true, tree.reason);
  try {
    assert.strictEqual(
      fs.readFileSync(path.join(tree.dir, "lib", "add.js"), "utf8").trim(),
      "module.exports = (a, b) => a * b;",
      "the implementer's source is what is under test"
    );
    assert.match(fs.readFileSync(path.join(tree.dir, "test", "acceptance.js"), "utf8"), /add is broken/, "the suite is main's");
    const gated = await gateRunner.runGateCommand(gate, tree.dir);
    assert.strictEqual(gated.ok, false);
    assert.match(gated.output, /add is broken/);
  } finally {
    tree.cleanup();
  }
  assert.ok(!fs.existsSync(tree.dir), "the gate worktree is cleaned up");
});

test("a protected test file the branch ADDED is removed from the gate tree, not carried into it", () => {
  const dir = repoWithBranch({ weakenTest: false });
  fs.writeFileSync(path.join(dir, "test", "extra.js"), "process.exit(0);\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "added a test");
  const change = gateRunner.gateChangeSet({ cwd: dir }, "main");
  const tree = gateRunner.prepareGateTree(change, { trustedRef: "main", protectedPaths: ["test/**"] });
  try {
    assert.strictEqual(tree.ok, true, tree.reason);
    assert.ok(!fs.existsSync(path.join(tree.dir, "test", "extra.js")));
    assert.ok(fs.existsSync(path.join(tree.dir, "test", "acceptance.js")));
  } finally {
    tree.cleanup();
  }
});

test("runGateCommand reports a non-zero exit and a timeout distinctly, never throws, and never blocks the event loop", async () => {
  const dir = repoWithBranch({ weakenTest: false });
  const ok = await gateRunner.runGateCommand({ id: "g", command: `"${process.execPath}" -e "process.exit(0)"`, timeoutMs: 30000, dir: "" }, dir);
  assert.deepStrictEqual([ok.ok, ok.code], [true, 0]);
  const bad = await gateRunner.runGateCommand({ id: "g", command: `"${process.execPath}" -e "process.exit(3)"`, timeoutMs: 30000, dir: "" }, dir);
  assert.deepStrictEqual([bad.ok, bad.code], [false, 3]);
  // The event loop must keep turning while the suite runs — the worker still
  // has runs to harvest, a status to publish and a SIGTERM handler to serve.
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 50);
  const slow = await gateRunner.runGateCommand(
    { id: "g", command: `"${process.execPath}" -e "setTimeout(()=>{},5000)"`, timeoutMs: 700, dir: "" },
    dir
  );
  clearInterval(ticker);
  assert.strictEqual(slow.ok, false);
  assert.match(slow.reason, /did not finish/);
  assert.ok(ticks > 2, `the loop kept turning during the gate command (ticks: ${ticks})`);
});

// ------------------------------------------------------- the loop's plumbing --

// The same fake-world driver work-loop.test.js uses, plus a gate.
function loopHarness({ queue = [], gate = null, terminalState = "resolved", enforced = true, maxPasses = 12 } = {}) {
  const state = { clock: 1_700_000_000_000, runs: new Map(), log: [], gateCalls: [], published: [] };
  const control = { stopping: false, reason: null, wake: () => {} };
  let seq = 0;
  let resolveGate = null;
  const deps = {
    now: () => state.clock,
    log: (l) => state.log.push(l),
    publish: (s) => state.published.push(JSON.parse(JSON.stringify(s))),
    // Agent-ready by default: the loop's `ready` accept policy would otherwise
    // skip these bare fixtures, and gating — not acceptance — is what these
    // tests are about (the policy has its own tests in work-loop.test.js).
    candidates: async () => queue.map((it) => (it && it.id ? { readiness: "agent", ...it } : it)),
    dispatch: async (item) => {
      const runId = `run-${++seq}`;
      state.runs.set(runId, {
        run_id: runId,
        node_id: item.id,
        state: "done",
        terminal_state: terminalState,
        terminal_enforced: enforced,
      });
      return { ok: true, run: { run_id: runId, harness: "fake", launch_mode: "supervised-jsonl" } };
    },
    pollRuns: async (ids) => ids.map((id) => ({ run_id: id, terminal: true, record: state.runs.get(id) })),
    sleep: async (ms) => {
      state.clock += ms;
      state.published.push({ tick: true });
      if (resolveGate) {
        const r = resolveGate;
        resolveGate = null;
        r();
      }
      if (state.published.filter((p) => p.tick).length >= maxPasses) control.stopping = true;
    },
    ...(gate
      ? {
          gate: (entry, record) => {
            state.gateCalls.push({ entry, record });
            // Settle on the NEXT sleep, so the test sees a pass with the item
            // still gating (the slot held) before the verdict lands.
            return new Promise((resolve, reject) => {
              resolveGate = () => {
                try {
                  resolve(gate(entry, record));
                } catch (e) {
                  reject(e);
                }
              };
            });
          },
        }
      : {}),
  };
  return { deps, control, state };
}

test("with NO factory the loop is unchanged: nothing gates, nothing is held, no gate counters", async () => {
  const { deps, control } = loopHarness({ queue: [{ id: "task-a" }] });
  const status = await workLoop.runWorkLoop({ opts: { workerId: "w", once: true, intervalMs: 1000 }, deps, control });
  assert.strictEqual(status.dispatched, 1);
  assert.strictEqual(status.outcomes.resolved, 1);
  assert.strictEqual(status.gates, undefined, "a bare worker publishes no gate counters");
  assert.deepStrictEqual(status.gating, []);
  assert.deepStrictEqual(status.skipped, []);
});

test("the LIVE loop enforces the factory's repo scope — an out-of-scope item is never dispatched, let alone gated", async () => {
  // issue-spor-work-scope-union-factory-mismatch. The --print path and
  // selectWorkCandidates are pinned in work-loop.test.js; this pins the path
  // that actually LAUNCHES, which is the one that could silently lose the
  // filter.
  const { deps, control, state } = loopHarness({
    queue: [
      { id: "task-other", project: "spor" },
      { id: "task-mine", project: "spor-server" },
    ],
    gate: () => ({ state: "passed", reason: "1 gate(s) passed" }),
  });
  const status = await workLoop.runWorkLoop({
    opts: { workerId: "w", concurrency: 2, intervalMs: 1000, max: 1, repos: ["spor-server"], factory: "factory-spor-server" },
    deps,
    control,
  });
  assert.strictEqual(status.dispatched, 1);
  assert.deepStrictEqual(state.gateCalls.map((c) => c.entry.node_id), ["task-mine"]);
  assert.deepStrictEqual(status.skipped.map((s) => s.id), ["task-other"]);
  assert.match(status.skipped[0].reason, /outside the factory's repo scope \(repo spor; this factory judges spor-server\)/);
  assert.deepStrictEqual(status.repos, ["spor-server"], "the scope a worker is enforcing is on its status record");
  // The gate fact is filed under the ITEM's own repo, not the worker's scope
  // token — they differ under a multi-repo factory.
  assert.strictEqual(state.gateCalls[0].entry.project, "spor-server");
  // ...and that repo survives the active->gating move ON THE PUBLISHED SLOT,
  // which is the only copy a resuming worker gets after this one is killed.
  const gatingSlot = state.published.flatMap((p) => p.gating || []).find((g) => g.node_id === "task-mine");
  assert.ok(gatingSlot, "the item was published as gating");
  assert.strictEqual(gatingSlot.project, "spor-server");
  // The orphan scan reads it straight back off that slot.
  assert.deepStrictEqual(
    workLoop
      .orphanedGateRuns([{ worker_id: "dead", live: false, factory: "factory-spor-server", gating: [gatingSlot] }], {
        records: new Map([[gatingSlot.run_id, { ...ORPHAN_RECORD, run_id: gatingSlot.run_id, node_id: "task-mine" }]]),
        factory: "factory-spor-server",
      })
      .map((o) => o.project),
    ["spor-server"]
  );
});

test("a scoped worker whose whole page belongs to other repos SAYS so — it does not just idle like an empty queue", async () => {
  const { deps, control, state } = loopHarness({
    queue: [{ id: "task-other", project: "spor" }],
    gate: () => ({ state: "passed" }),
  });
  const status = await workLoop.runWorkLoop({
    opts: { workerId: "w", intervalMs: 1000, once: true, repos: ["spor-server"], factory: "factory-spor-server" },
    deps,
    control,
  });
  assert.strictEqual(status.dispatched, 0);
  const notice = state.log.find((l) => /outside the factory's repo scope \(spor-server\)/.test(l));
  assert.ok(notice, `expected a scope-starvation notice, got:\n${state.log.join("\n")}`);
  assert.match(notice, /Narrow the read with --project, or widen the factory's 'repos'/);
});

test("a resolved run holds its slot through the gate pipeline, and a PASS clears it with no cooldown", async () => {
  const { deps, control, state } = loopHarness({
    queue: [{ id: "task-a" }],
    gate: () => ({ state: "passed", reason: "2 gate(s) passed", facts: ["art-gate-x"] }),
  });
  const status = await workLoop.runWorkLoop({ opts: { workerId: "w", concurrency: 1, intervalMs: 1000, max: 1 }, deps, control });
  assert.strictEqual(state.gateCalls.length, 1);
  assert.strictEqual(state.gateCalls[0].entry.node_id, "task-a");
  assert.strictEqual(status.gates.passed, 1);
  assert.deepStrictEqual(status.gating, []);
  assert.deepStrictEqual(status.skipped, [], "a gated-and-passed item is done — no cooldown");
  assert.strictEqual(status.recent[0].gate, "passed");
  // The slot was genuinely held: a pass ran while the item was still gating.
  const held = state.published.some((p) => p.gating && p.gating.length === 1);
  assert.ok(held, "the item occupied a slot while its gates ran");
});

test("a FAILED gate cools the item off — a worker does not re-dispatch what its own gate just refused", async () => {
  const { deps, control } = loopHarness({
    queue: [{ id: "task-a" }],
    gate: () => ({ state: "failed", reason: "gate 'acceptance' failed: npm test exited 1", escalated_to: "task-gate-acceptance" }),
  });
  const status = await workLoop.runWorkLoop({ opts: { workerId: "w", intervalMs: 1000, retryAfterMs: 600000, max: 1 }, deps, control });
  assert.strictEqual(status.gates.failed, 1);
  assert.strictEqual(status.skipped.length, 1);
  assert.strictEqual(status.skipped[0].id, "task-a");
  assert.match(status.skipped[0].reason, /gate pipeline failed/);
  assert.strictEqual(status.recent[0].gate, "failed");
  assert.strictEqual(status.recent[0].escalated_to, "task-gate-acceptance");
});

test("a BLOCKED gate (waiting on a person) also cools the item, and a thrown pipeline is a failure, not a crash", async () => {
  let blocked = await workLoop.runWorkLoop({
    opts: { workerId: "w", intervalMs: 1000, max: 1 },
    ...(() => {
      const h = loopHarness({ queue: [{ id: "task-a" }], gate: () => ({ state: "blocked", reason: "waiting on task-approve-x" }) });
      return { deps: h.deps, control: h.control };
    })(),
  });
  assert.strictEqual(blocked.gates.blocked, 1);
  assert.strictEqual(blocked.skipped.length, 1);

  const thrown = loopHarness({
    queue: [{ id: "task-a" }],
    gate: () => {
      throw new Error("git exploded");
    },
  });
  const status = await workLoop.runWorkLoop({ opts: { workerId: "w", intervalMs: 1000, max: 1 }, deps: thrown.deps, control: thrown.control });
  assert.strictEqual(status.gates.failed, 1);
  assert.match(status.recent[0].gate_reason, /git exploded/);
});

test("a PARKED integration (propose mode) frees the slot exactly like any other settled verdict — no special-casing needed (task-spor-integration-propose-mode)", async () => {
  const { deps, control, state } = loopHarness({
    queue: [{ id: "task-a" }],
    gate: () => ({ state: "parked", reason: "integration proposed: opened PR #42", escalated_to: "task-integration-proposed-x" }),
  });
  const status = await workLoop.runWorkLoop({ opts: { workerId: "w", concurrency: 1, intervalMs: 1000, max: 1 }, deps, control });
  assert.strictEqual(state.gateCalls.length, 1);
  assert.strictEqual(status.gates.parked, 1);
  assert.deepStrictEqual(status.gating, [], "the slot is freed the moment the pipeline settles, not held for a pending PR review");
  assert.strictEqual(status.recent[0].gate, "parked");
  assert.strictEqual(status.recent[0].escalated_to, "task-integration-proposed-x");
  // The slot really was held WHILE parking — same evidence the PASS test above
  // checks — proving nothing here special-cases "parked" into skipping the hold.
  const held = state.published.some((p) => p.gating && p.gating.length === 1);
  assert.ok(held, "the item occupied a slot while its pipeline settled");
});

test("deps.checkProposals runs once per pass when present (propose mode), and is never called when absent — a bare/local/push factory's loop is unchanged", async () => {
  const { deps, control } = loopHarness({ queue: [{ id: "task-a" }] });
  let calls = 0;
  deps.checkProposals = async () => {
    calls += 1;
  };
  await workLoop.runWorkLoop({ opts: { workerId: "w", once: true, intervalMs: 1000 }, deps, control });
  assert.ok(calls >= 1, "checkProposals runs at least once per pass when the deps hook is present");

  const bare = loopHarness({ queue: [{ id: "task-a" }] });
  const status = await workLoop.runWorkLoop({ opts: { workerId: "w", once: true, intervalMs: 1000 }, deps: bare.deps, control: bare.control });
  assert.strictEqual(status.dispatched, 1, "no checkProposals dep -> the loop runs exactly as before this hook existed");
});

test("only a claimed completion is gated: an enforced 'reported' run is not, an UNENFORCED one is", async () => {
  const enforcedReported = loopHarness({
    queue: [{ id: "task-a" }],
    gate: () => ({ state: "passed" }),
    terminalState: "reported",
    enforced: true,
  });
  await workLoop.runWorkLoop({ opts: { workerId: "w", once: true, intervalMs: 1000 }, deps: enforcedReported.deps, control: enforcedReported.control });
  assert.strictEqual(enforcedReported.state.gateCalls.length, 0, "a run that self-declares not-done has no claim to test");

  const unenforced = loopHarness({
    queue: [{ id: "task-a" }],
    gate: () => ({ state: "passed" }),
    terminalState: "reported",
    enforced: false,
  });
  await workLoop.runWorkLoop({ opts: { workerId: "w", intervalMs: 1000, max: 1 }, deps: unenforced.deps, control: unenforced.control });
  assert.strictEqual(unenforced.state.gateCalls.length, 1, "an unverifiable claim is exactly where the gates are the only check");

  assert.strictEqual(workLoop.shouldGate({ terminal_state: "failed", terminal_enforced: true }), false);
  assert.strictEqual(workLoop.shouldGate({}), false);
});

// A gating item is UNFINISHED work: its node is not a candidate. Without this
// the second free slot re-dispatches the very item the first gate is judging —
// and for a `resolved` run there is no cooldown standing in the way, because a
// resolved item is supposed to have left the queue by itself.
test("a GATING item is not a candidate: a free slot never re-dispatches what this worker's own gate is still judging", async () => {
  const state = { clock: 1_700_000_000_000, runs: new Map(), dispatched: [], gateCalls: 0, ticks: 0 };
  const control = { stopping: false, reason: null, wake: () => {} };
  let seq = 0;
  const deps = {
    now: () => state.clock,
    log: () => {},
    publish: () => {},
    candidates: async () => [{ id: "task-a", readiness: "agent" }],
    dispatch: async (item) => {
      const runId = `run-${++seq}`;
      state.dispatched.push(item.id);
      state.runs.set(runId, { run_id: runId, node_id: item.id, state: "done", terminal_state: "resolved", terminal_enforced: true });
      return { ok: true, run: { run_id: runId, harness: "fake" } };
    },
    pollRuns: async (ids) => ids.map((id) => ({ run_id: id, terminal: true, record: state.runs.get(id) })),
    // A pipeline that never settles — a human gate waiting on a person.
    gate: () => {
      state.gateCalls += 1;
      return new Promise(() => {});
    },
    sleep: async (ms) => {
      state.clock += ms;
      if ((state.ticks += 1) >= 4) control.stopping = true;
    },
  };
  const status = await workLoop.runWorkLoop({ opts: { workerId: "w", concurrency: 2, intervalMs: 1000 }, deps, control });
  assert.deepStrictEqual(state.dispatched, ["task-a"], "one dispatch, not one per free slot");
  assert.strictEqual(state.gateCalls, 1, "and one gate pipeline, not a second racing the first");
  assert.strictEqual(status.gating.length, 1);
});

// ------------------------------------------- interrupted pipelines, resumed --
// A gate pipeline is the ONE piece of work the worker PROCESS owns, so a worker
// that dies mid-pipeline abandons it — and the run it was judging is already
// terminal and already out of the queue, so no candidate poll would ever come
// back to it. "Re-gates on the next run" has to be something a worker does.

const ORPHAN_RECORD = { run_id: "run-orphan", node_id: "task-orphan", state: "done", terminal_state: "resolved", terminal_enforced: true, finished_at: "2026-08-26T00:00:00.000Z" };

test("orphanedGateRuns joins the dead workers' slots to the run journal, and no live worker's", () => {
  const records = new Map([["run-orphan", ORPHAN_RECORD]]);
  const slot = { run_id: "run-orphan", node_id: "task-orphan", harness: "fake" };
  // `gates` is the gate-armed marker: the worker status file carries that tally
  // if and only if the worker ran with a factory.
  const dead = (extra = {}) => ({ worker_id: "w1", live: false, gates: { passed: 0, failed: 0, blocked: 0 }, gating: [slot], active: [], ...extra });

  assert.deepStrictEqual(
    workLoop.orphanedGateRuns([dead()], { records }).map((o) => [o.run_id, o.node_id]),
    [["run-orphan", "task-orphan"]]
  );

  // A LIVE worker owns its own slots — two workers must not both resume one.
  assert.deepStrictEqual(workLoop.orphanedGateRuns([{ ...dead(), live: true }], { records }), []);
  assert.deepStrictEqual(
    workLoop.orphanedGateRuns([dead(), { worker_id: "w2", live: true, gating: [slot], active: [] }], { records }),
    [],
    "a run a live worker is already gating is not an orphan, whoever else once held it"
  );

  // A GATE-ARMED worker's ACTIVE slot counts too: one killed with runs in
  // flight never reaches the harvest that would have started their gates.
  assert.strictEqual(workLoop.orphanedGateRuns([dead({ gating: [], active: [slot] })], { records }).length, 1);

  // A settled verdict is not an orphan; an unsettled stamp is.
  for (const gate_state of ["passed", "failed", "blocked"]) {
    assert.deepStrictEqual(workLoop.orphanedGateRuns([dead()], { records: new Map([["run-orphan", { ...ORPHAN_RECORD, gate_state }]]) }), []);
  }
  for (const gate_state of ["running", "interrupted"]) {
    assert.strictEqual(workLoop.orphanedGateRuns([dead()], { records: new Map([["run-orphan", { ...ORPHAN_RECORD, gate_state }]]) }).length, 1, gate_state);
  }

  // Nothing to gate, nothing to resume: a pruned record, a run with no claim,
  // and a run past the worker's own ceiling on how long it follows one.
  assert.deepStrictEqual(workLoop.orphanedGateRuns([dead()], { records: new Map() }), []);
  assert.deepStrictEqual(
    workLoop.orphanedGateRuns([dead()], { records: new Map([["run-orphan", { ...ORPHAN_RECORD, terminal_state: "reported", terminal_enforced: true }]]) }),
    [],
    "an enforced 'reported' run self-declares not-done — there is no claim to gate"
  );
  assert.deepStrictEqual(
    workLoop.orphanedGateRuns([dead()], { records, now: () => Date.parse("2026-09-30T00:00:00.000Z"), maxAgeMs: 86400000 }),
    []
  );

  // A run record already claimed `running` by a worker that is STILL LIVE is
  // that worker's, even though nothing has settled: a worker stamps the record
  // before it publishes its slot, so this is the earlier of the two signals
  // that keep two workers off one orphan.
  const claimed = new Map([["run-orphan", { ...ORPHAN_RECORD, gate_state: "running", gate_worker: "w9" }]]);
  assert.deepStrictEqual(workLoop.orphanedGateRuns([dead(), { worker_id: "w9", live: true, gating: [], active: [] }], { records: claimed }), []);
  assert.strictEqual(
    workLoop.orphanedGateRuns([dead(), { worker_id: "w9", live: false, gating: [], active: [] }], { records: claimed }).length,
    1,
    "…but the same claim from a worker that is GONE is exactly what a resume is for"
  );
});

// `active` is populated by EVERY worker, bare ones included — and a bare worker
// (no factory, the shipped default) was never owed a gate at all. Adopting its
// runs would let a gate-armed worker retroactively judge work nobody meant to
// gate, and on a refusal file a `blocks` edge and roll back the status of an
// item a person may have deliberately closed.
test("a dead BARE worker's runs are never adopted — a gate is only ever imposed on work that was owed one", () => {
  const records = new Map([["run-orphan", ORPHAN_RECORD]]);
  const slot = { run_id: "run-orphan", node_id: "task-orphan", harness: "fake" };
  const armed = { passed: 0, failed: 0, blocked: 0 };

  // Same dead worker, same terminal run, same gateable claim — the ONLY
  // difference is whether that worker itself ran gate-armed.
  assert.deepStrictEqual(
    workLoop.orphanedGateRuns([{ worker_id: "bare", live: false, gating: [], active: [slot] }], { records }),
    [],
    "a bare worker's run was never owed a gate"
  );
  assert.strictEqual(
    workLoop.orphanedGateRuns([{ worker_id: "armed", live: false, gates: armed, gating: [], active: [slot] }], { records }).length,
    1,
    "…and a gate-armed worker's run was"
  );

  // A `gating` slot is self-evidencing — it could not exist without a pipeline
  // — so it is honored even if the tally is missing from a mangled record.
  assert.strictEqual(
    workLoop.orphanedGateRuns([{ worker_id: "odd", live: false, gating: [slot], active: [] }], { records }).length,
    1
  );

  // resumableSlots is the whole rule, in isolation.
  assert.deepStrictEqual(workLoop.resumableSlots({ gates: armed, gating: [slot], active: [slot] }).length, 2);
  assert.deepStrictEqual(workLoop.resumableSlots({ gating: [], active: [slot] }), []);
  assert.deepStrictEqual(workLoop.resumableSlots(null), []);
});

test("an orphan is only ever adopted by the factory that started it — a resume is not a back door into another repo", () => {
  // issue-spor-work-scope-union-factory-mismatch: a resumed pipeline never goes
  // through candidate selection, so the repo-scope guard there does not reach
  // it. Without this, a worker armed with factory B finishes a pipeline factory
  // A started — running B's suite and B's integration command against A's repo,
  // and on a refusal filing a `blocks` edge and rolling the item's status back.
  const records = new Map([["run-orphan", ORPHAN_RECORD]]);
  const slot = { run_id: "run-orphan", node_id: "task-orphan", harness: "fake" };
  const dead = (factory) => ({ worker_id: "w1", live: false, factory, gates: { passed: 0, failed: 0, blocked: 0 }, gating: [slot], active: [] });

  assert.strictEqual(workLoop.orphanedGateRuns([dead("factory-a")], { records, factory: "factory-a" }).length, 1, "the same factory finishes its own work");

  const foreign = [];
  assert.deepStrictEqual(
    workLoop.orphanedGateRuns([dead("factory-a")], { records, factory: "factory-b", onForeign: (o) => foreign.push(o) }),
    [],
    "a different factory does not adopt it"
  );
  assert.deepStrictEqual(foreign.map((o) => [o.node_id, o.factory]), [["task-orphan", "factory-a"]], "…and it is reported, not silently stranded");

  // Both of the pre-existing shapes are untouched: a caller that passes no
  // factory, and a dead record that carries none, behave exactly as before.
  assert.strictEqual(workLoop.orphanedGateRuns([dead("factory-a")], { records }).length, 1);
  assert.strictEqual(workLoop.orphanedGateRuns([dead(undefined)], { records, factory: "factory-b" }).length, 1);
});

// A resumed pipeline RE-RUNS its gates from the first one, and a fix cycle
// dispatches an implementer with --force --no-worktree into the run's own
// checkout. The abandoned pipeline's fix agent is DETACHED and outlived the
// worker that started it, so adopting while it works would put two agents in
// one checkout — the hazard worktree isolation exists to remove.
test("an orphan whose node still has a live run is DEFERRED, not adopted — never two agents in one checkout", () => {
  const TERMINAL = new Set(["done", "failed", "failed_launch", "vanished"]);
  const dead = { worker_id: "w1", live: false, gating: [{ run_id: "run-orphan", node_id: "task-orphan", harness: "fake" }], active: [] };
  const withFix = (state) =>
    new Map([
      ["run-orphan", ORPHAN_RECORD],
      // The fix cycle the abandoned pipeline dispatched at the same node.
      ["run-fix", { run_id: "run-fix", node_id: "task-orphan", state, created_at: new Date().toISOString() }],
    ]);

  assert.deepStrictEqual(
    workLoop.orphanedGateRuns([dead], { records: withFix("running"), terminalStates: TERMINAL }),
    [],
    "a live agent at that node defers the resume"
  );
  assert.strictEqual(
    workLoop.orphanedGateRuns([dead], { records: withFix("done"), terminalStates: TERMINAL }).length,
    1,
    "deferred, not dropped: once that agent's run is terminal the orphan is adopted"
  );
  // A record aged past the worker's own watchdog ceiling is not evidence of a
  // live agent — that is precisely the record runHarvest gives up on — so it
  // must not defer the orphan forever.
  const stale = new Map([
    ["run-orphan", ORPHAN_RECORD],
    ["run-fix", { run_id: "run-fix", node_id: "task-orphan", state: "running", created_at: "2020-01-01T00:00:00.000Z" }],
  ]);
  // Pin `now` to ORPHAN_RECORD's own finished_at rather than the real wall
  // clock: this assertion means to test the run-fix record aging out of
  // busyNodes (its `created_at` is 2020, always stale), not ORPHAN_RECORD's
  // own age against maxAgeMs's watchdog on line ~458 — using real Date.now()
  // made this fail once real-world time drifted more than a day past
  // ORPHAN_RECORD.finished_at (2026-08-26), which is exactly what happened.
  assert.strictEqual(
    workLoop.orphanedGateRuns([dead], {
      records: stale,
      terminalStates: TERMINAL,
      maxAgeMs: 86400000,
      now: () => Date.parse(ORPHAN_RECORD.finished_at),
    }).length,
    1
  );
});

test("gatingNodeIds names what LIVE workers are gating — the cross-worker half of the candidate exclusion", () => {
  const ids = workLoop.gatingNodeIds([
    { worker_id: "a", live: true, gating: [{ run_id: "r1", node_id: "task-a" }], active: [{ run_id: "r9", node_id: "task-active" }] },
    { worker_id: "b", live: false, gating: [{ run_id: "r2", node_id: "task-b" }] },
    { worker_id: "c", live: true, gating: [] },
    null,
  ]);
  // A live worker's gating node only. A DEAD worker's is not excluded — that
  // one is an orphan to be resumed, not work in progress — and `active` is
  // already covered by the in-flight agent guard.
  assert.deepStrictEqual([...ids], ["task-a"]);
  assert.deepStrictEqual([...workLoop.gatingNodeIds(null)], []);
});

test("a worker RESUMES an unfinished gate pipeline before taking new work, and stamps the verdict on the run record", async () => {
  const marks = [];
  const h = loopHarness({ queue: [], gate: () => ({ state: "failed", reason: "the acceptance suite still fails" }), maxPasses: 6 });
  h.deps.markGate = (runId, patch) => marks.push({ run_id: runId, ...patch });
  // The real scan stops offering a run once a LIVE worker stamps it `running`.
  h.deps.pendingGates = async () =>
    marks.some((m) => m.gate_state === "running") ? [] : [{ run_id: "run-orphan", node_id: "task-orphan", harness: "fake", record: ORPHAN_RECORD }];

  const status = await workLoop.runWorkLoop({ opts: { workerId: "w2", concurrency: 1, intervalMs: 1000 }, deps: h.deps, control: h.control });
  assert.strictEqual(h.state.gateCalls.length, 1, "the abandoned pipeline is picked up, not left standing forever");
  assert.strictEqual(h.state.gateCalls[0].entry.node_id, "task-orphan");
  assert.strictEqual(status.gates.failed, 1);
  assert.deepStrictEqual(status.gating, []);
  assert.strictEqual(status.recent[0].node_id, "task-orphan");
  assert.strictEqual(status.recent[0].gate, "failed", "and the resumed run gets its verdict on the status surface");
  assert.strictEqual(status.skipped[0].id, "task-orphan", "a refused resume cools the node like any other");
  assert.deepStrictEqual(marks.map((m) => m.gate_state), ["running", "failed"]);
  assert.strictEqual(marks[0].gate_worker, "w2");
  assert.ok(marks.every((m) => m.gate_at), "every stamp is dated");
});

test("resumption is bounded by the free slots, comes AHEAD of new work, and stops when the worker winds down", async () => {
  const state = { clock: 1_700_000_000_000, ticks: 0, dispatched: 0, gated: [] };
  const control = { stopping: false, reason: null, wake: () => {} };
  const orphan = (n) => ({ run_id: `run-orphan-${n}`, node_id: `task-orphan-${n}`, harness: "fake", record: { ...ORPHAN_RECORD, run_id: `run-orphan-${n}`, node_id: `task-orphan-${n}` } });
  const deps = {
    now: () => state.clock,
    log: () => {},
    publish: () => {},
    candidates: async () => [{ id: "task-a", readiness: "agent" }],
    dispatch: async () => {
      state.dispatched += 1;
      return { ok: true, run: { run_id: "run-new", harness: "fake" } };
    },
    pollRuns: async (ids) => ids.map((id) => ({ run_id: id, terminal: true, record: { run_id: id, node_id: "task-a", state: "done", terminal_state: "resolved", terminal_enforced: true } })),
    // Three orphans on offer, on every pass, forever.
    pendingGates: async () => [orphan(1), orphan(2), orphan(3)],
    gate: (entry) => {
      state.gated.push(entry.node_id);
      return { state: "passed" };
    },
    sleep: async (ms) => {
      state.clock += ms;
      if ((state.ticks += 1) >= 6) control.stopping = true; // a backstop; --once should end this first
    },
  };
  await workLoop.runWorkLoop({ opts: { workerId: "w", concurrency: 2, intervalMs: 1000, once: true }, deps, control });
  // Pass 1 has two free slots: both go to orphans, ahead of the queue —
  // finishing what this box already promised to judge outranks starting
  // something else. The third waits for a slot; a DRAINING pass (--once, past
  // its first) takes on nothing new, so it waits for the next worker instead.
  assert.deepStrictEqual(state.gated, ["task-orphan-1", "task-orphan-2"]);
  assert.strictEqual(state.dispatched, 0, "the free slots went to the unfinished gates, not to new work");
});

test("a stop folds in the verdicts that DID land before abandoning the rest", async () => {
  // The loop has SEVERAL exits, and the one a signal actually takes is not the
  // stop-condition step: `control.stopping` is set by a handler at any instant,
  // and a stop that lands during slot-filling breaks out at the end of the pass
  // — after that pass's settle has already run. A pipeline that reported in
  // that window has a verdict, and abandoning it so the next worker re-runs the
  // whole thing (a suite, a review dispatch, a fix cycle) is pure waste. So the
  // final fold lives on the way OUT of the loop, where every exit reaches it.
  const marks = [];
  const state = { clock: 1_700_000_000_000, ticks: 0 };
  const control = { stopping: false, reason: null, wake: () => {} };
  const settle = new Map(); // run_id -> resolve
  const deps = {
    now: () => state.clock,
    log: () => {},
    publish: () => {},
    candidates: async () => {
      // A pass with a free slot reaches the queue poll — and this is where the
      // SIGTERM lands, mid-pass, with one pipeline's verdict arriving with it.
      if (settle.has("run-task-a") && !control.stopping) {
        settle.get("run-task-a")({ state: "failed", reason: "the suite fails" });
        await new Promise((r) => setImmediate(r)); // let the verdict reach its job handle
        control.stopping = true;
      }
      return [{ id: "task-a", readiness: "agent" }, { id: "task-b", readiness: "agent" }];
    },
    dispatch: async (item) => ({ ok: true, run: { run_id: `run-${item.id}`, harness: "fake" } }),
    pollRuns: async (ids) =>
      ids.map((id) => ({ run_id: id, terminal: true, record: { run_id: id, node_id: id.replace("run-", ""), state: "done", terminal_state: "resolved", terminal_enforced: true } })),
    gate: (entry) => new Promise((resolve) => settle.set(entry.run_id, resolve)),
    markGate: (runId, patch) => marks.push({ run_id: runId, ...patch }),
    sleep: async (ms) => {
      state.clock += ms;
      state.ticks += 1;
      await new Promise((r) => setImmediate(r)); // the pipelines start in a microtask
      if (state.ticks > 5) control.stopping = true; // a backstop, never reached
    },
  };
  const status = await workLoop.runWorkLoop({ opts: { workerId: "w", concurrency: 3, intervalMs: 1000 }, deps, control });
  assert.strictEqual(status.gates.failed, 1, "a verdict that exists is recorded, not thrown away for the next worker to re-run");
  assert.deepStrictEqual(status.gating.map((g) => g.node_id), ["task-b"], "and only the pipeline that never reported is abandoned");
  assert.deepStrictEqual(
    marks.filter((m) => m.run_id === "run-task-a").map((m) => m.gate_state),
    ["running", "failed"],
    "the settled run is stamped with its verdict, never 'interrupted'"
  );
  assert.deepStrictEqual(
    marks.filter((m) => m.run_id === "run-task-b").map((m) => m.gate_state),
    ["running", "interrupted"],
    "and the one that never reported is left in the state the next worker resumes from"
  );
});

test("a stop marks its abandoned pipelines INTERRUPTED — the state the next worker resumes from", async () => {
  const marks = [];
  const state = { clock: 1_700_000_000_000, ticks: 0 };
  const control = { stopping: false, reason: null, wake: () => {} };
  const deps = {
    now: () => state.clock,
    log: () => {},
    publish: () => {},
    candidates: async () => [{ id: "task-a", readiness: "agent" }],
    dispatch: async () => ({ ok: true, run: { run_id: "run-1", harness: "fake" } }),
    pollRuns: async (ids) => ids.map((id) => ({ run_id: id, terminal: true, record: { run_id: id, node_id: "task-a", state: "done", terminal_state: "resolved", terminal_enforced: true } })),
    gate: () => new Promise(() => {}),
    markGate: (runId, patch) => marks.push({ run_id: runId, ...patch }),
    sleep: async (ms) => {
      state.clock += ms;
      if ((state.ticks += 1) >= 2) control.stopping = true;
    },
  };
  const status = await workLoop.runWorkLoop({ opts: { workerId: "w", concurrency: 1, intervalMs: 1000 }, deps, control });
  assert.strictEqual(status.gating.length, 1, "the slot stays in the published record — it is what the next worker joins on");
  assert.deepStrictEqual(marks.map((m) => m.gate_state), ["running", "interrupted"]);
});

test("the resume scan reads back what the run journal and the worker status files actually store", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-resume-"));
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  fs.mkdirSync(dispatchRuns.dispatchRunDir(home), { recursive: true });
  const runId = "11111111-2222-3333-4444-555555555555";
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, runId).record, {
    run_id: runId, node_id: "task-orphan", state: "done", terminal_state: "resolved", terminal_enforced: true, created_at: new Date().toISOString(),
  });
  // A worker record with a pid that is gone: STALE, never running (the same
  // reading `spor work --status` gives an operator).
  workLoop.writeWorkerStatus(home, {
    worker_id: "dead", pid: 999999, started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    active: [], gating: [{ run_id: runId, node_id: "task-orphan", harness: "fake", started_at: new Date().toISOString() }],
  });
  const scan = () =>
    workLoop.orphanedGateRuns(workLoop.readWorkerStatuses(home, { alive: () => false }), {
      records: new Map(dispatchRuns.readRunRecords(home).map((r) => [r.run_id, r])),
    });
  assert.deepStrictEqual(scan().map((o) => o.node_id), ["task-orphan"]);

  // …and once a pipeline settles, the stamp takes it out of the scan for good.
  assert.ok(dispatchRuns.stampGateState(home, runId, { gate_state: "passed", gate_at: new Date().toISOString() }));
  assert.deepStrictEqual(scan(), []);
  assert.strictEqual(dispatchRuns.stampGateState(home, "no-such-run", { gate_state: "passed" }), null);

  // A SETTLED verdict is final for this run. Two workers can, in a narrow
  // window, both adopt one orphan; without this the loser's later `passed`
  // would overwrite the winner's refusal — a refusal laundered into an
  // approval, the one direction this feature must never fail in.
  const refused = dispatchRuns.stampGateState(home, runId, { gate_state: "failed", gate_reason: "the suite fails" });
  assert.strictEqual(refused.gate_state, "passed", "the settled verdict stands");
  assert.strictEqual(refused.gate_reason, undefined);
  assert.strictEqual(
    dispatchRuns.stampGateState(home, runId, { gate_state: "interrupted" }).gate_state,
    "passed",
    "and a stop cannot reopen one either"
  );
  assert.strictEqual(dispatchRuns.stampGateState(home, runId, { terminal_state: "failed" }), null, "a patch with nothing of its own writes nothing at all");
});

test("a gate stamp only ever writes its own namespace, and survives the writers that own the record", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-stamp-"));
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  fs.mkdirSync(dispatchRuns.dispatchRunDir(home), { recursive: true });
  const runId = "22222222-3333-4444-5555-666666666666";
  const paths = dispatchRuns.runPaths(home, runId);
  const base = { run_id: runId, node_id: "task-x", state: "done", terminal_state: "resolved", terminal_enforced: true, contract_pending: true };
  dispatchRuns.atomicJson(paths.record, base);

  // The process and outcome dimensions (§8) are not reachable from a gate
  // stamp, whatever a caller passes.
  const stamped = dispatchRuns.stampGateState(home, runId, { gate_state: "running", gate_worker: "w1", terminal_state: "failed", state: "vanished" });
  assert.deepStrictEqual(
    [stamped.terminal_state, stamped.state, stamped.gate_state, stamped.gate_worker],
    ["resolved", "done", "running", "w1"]
  );

  // …and the reverse: a supervised record goes terminal carrying a PROVISIONAL
  // `contract_pending` outcome, and the loop harvests (and starts gating) it
  // once the contract grace elapses. The supervisor's own later write comes
  // from an IN-MEMORY copy that predates the stamp, so without carrying the
  // namespace across it would silently erase the gate verdict this feature
  // promises is durable.
  const handle = { paths, record: { ...base } };
  dispatchRuns.updateRun(handle, { terminal_note: "verified on the graph", contract_pending: false });
  const after = dispatchRuns.readJson(paths.record);
  assert.strictEqual(after.contract_pending, false, "the supervisor's own patch still lands");
  assert.strictEqual(after.gate_state, "running", "and the out-of-band gate stamp survives it");
  assert.strictEqual(after.gate_worker, "w1");
});

// `carryGateFields` closes the ordinary ordering, but neither writer holds a
// lock: a supervisor that READ before a settle and RENAMED after it reverts the
// verdict to whatever its stale copy held. The consequence is bounded (the gate
// FACTS and the graph demotion have already landed, so a revert costs a re-run,
// not correctness) — and a verify-and-reapply pass closes it in practice.
test("a settle that gets clobbered by a concurrent whole-record write is re-applied, and yields to a real verdict", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-race-"));
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  fs.mkdirSync(dispatchRuns.dispatchRunDir(home), { recursive: true });
  const runId = "33333333-4444-5555-6666-777777777777";
  const paths = dispatchRuns.runPaths(home, runId);
  const base = { run_id: runId, node_id: "task-x", state: "done", terminal_state: "resolved", terminal_enforced: true, gate_state: "running" };
  // A supervisor whose rename straddles the settle: it puts its own stale copy
  // back on disk, reverting the verdict to `running`.
  const clobber = (extra = {}) => dispatchRuns.atomicJson(paths.record, { ...base, gate_state: "running", ...extra });

  dispatchRuns.atomicJson(paths.record, base);
  let reads = 0;
  const flaky = (file) => {
    reads += 1;
    if (reads === 1) {
      clobber({ terminal_note: "the supervisor's stale copy" });
      return dispatchRuns.readJson(file);
    }
    return dispatchRuns.readJson(file);
  };
  const settled = dispatchRuns.stampGateState(home, runId, { gate_state: "failed", gate_reason: "the suite fails" }, { readBack: flaky });
  assert.strictEqual(settled.gate_state, "failed");
  assert.strictEqual(reads, 2, "the clobbered write is noticed and re-applied, then verified");
  const onDisk = dispatchRuns.readJson(paths.record);
  assert.strictEqual(onDisk.gate_state, "failed", "the verdict is what is on disk");
  assert.strictEqual(onDisk.terminal_note, "the supervisor's stale copy", "and the supervisor's own write is not undone");

  // Retries are BOUNDED — a permanently contended file must not spin.
  dispatchRuns.atomicJson(paths.record, base);
  let spins = 0;
  const never = (file) => {
    spins += 1;
    clobber();
    return dispatchRuns.readJson(file);
  };
  dispatchRuns.stampGateState(home, runId, { gate_state: "failed" }, { verifyAttempts: 2, readBack: never });
  assert.strictEqual(spins, 2, "it gives up rather than spinning; the resume scan re-offers the run");

  // And if the clobber was ANOTHER worker legitimately settling first, the
  // retry yields to that verdict instead of fighting for the last word.
  dispatchRuns.atomicJson(paths.record, base);
  const raced = (file) => {
    dispatchRuns.atomicJson(paths.record, { ...base, gate_state: "blocked" }); // the other worker lands
    return dispatchRuns.readJson(file);
  };
  const yielded = dispatchRuns.stampGateState(home, runId, { gate_state: "failed" }, { readBack: raced });
  assert.strictEqual(yielded.gate_state, "blocked", "a settled verdict is final, whoever wrote it");
  assert.strictEqual(dispatchRuns.readJson(paths.record).gate_state, "blocked");
});

// ------------------------------------------- the approval oracle + gate ids --

const sporCli = require("../bin/spor.js");
const { loadConfig } = require("../lib/config.js");

// The approval item is read for ONE thing: a live resolving edge. Every other
// terminal status is a refusal — the dispatch guard's "is this resolved?"
// reading counts `closed`/`superseded`/`abandoned` as resolved, which is right
// for "would dispatching this redo finished work" and exactly backwards here.
test("an approval item approves ONLY on a resolving edge — every other terminal status is a refusal", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-approve-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const write = (id, front, body = "Body.") =>
    fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-26\n---\n${body}\n`);
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });

  write("task-approve-open", "type: task\ntitle: Approve the auth change\nsummary: A person must approve the security gate for the auth change before it counts as done.\nstatus: open\nrequires: [human]\n");
  assert.deepStrictEqual(await sporCli.gateApprovalState(cfg, "task-approve-open"), { state: "pending" });
  assert.deepStrictEqual(await sporCli.gateApprovalState(cfg, "task-approve-missing"), { state: "pending" });

  // Dismissed, not approved — the status the old hand-written reject set missed.
  for (const status of ["abandoned", "closed", "superseded"]) {
    write("task-approve-x", `type: task\ntitle: Approve the auth change\nsummary: A person must approve the security gate for the auth change before it counts as done.\nstatus: ${status}\n`);
    assert.strictEqual((await sporCli.gateApprovalState(cfg, "task-approve-x")).state, "rejected", `status ${status} is not an approval`);
  }

  // A resolver pointing at it IS the approval.
  write("task-approve-y", "type: task\ntitle: Approve the auth change\nsummary: A person must approve the security gate for the auth change before it counts as done.\nstatus: open\n");
  write(
    "dec-approved-it",
    "type: decision\ntitle: Approved the security gate\nsummary: Approved the security gate on the auth change after reading the diff and the threat model.\nstatus: accepted\nedges:\n  - {type: resolves, to: task-approve-y}\n"
  );
  const approved = await sporCli.gateApprovalState(cfg, "task-approve-y");
  assert.strictEqual(approved.state, "approved");
  assert.strictEqual(approved.by, "dec-approved-it");
});

// The demotion's own write door. Only a claim of COMPLETION is rolled back: a
// gate refuses "this is finished", it never reopens a person's decision to drop
// the work — and it never touches the resolving EDGE, which is the agent's own
// record of what it did and the evidence the escalation asks a person to judge.
test("a refused item's COMPLETION status is rolled back — and nothing else is", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-demote-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const write = (id, status, extra = "") =>
    fs.writeFileSync(
      path.join(nodes, `${id}.md`),
      `---\nid: ${id}\ntype: task\ntitle: Add bounded retry to the sync worker\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: ${status}\n${extra}date: 2026-08-26\n---\n\nBody.\n`
    );
  const statusOf = (id) => /^status: (.+)$/m.exec(fs.readFileSync(path.join(nodes, `${id}.md`), "utf8"))[1];

  // The whole point: the run wrote a resolver, so the graph reads DONE. The
  // gate refused it, and the graph must stop saying so.
  write("task-done", "done");
  fs.writeFileSync(
    path.join(nodes, "dec-resolver.md"),
    "---\nid: dec-resolver\ntype: decision\ntitle: Added bounded retry\nsummary: Added bounded retry with backoff to the sync worker, so a transient failure retries instead of dropping.\ndate: 2026-08-26\nedges:\n  - {type: resolves, to: task-done}\n---\n\nBody.\n"
  );
  const demoted = await sporCli.gateDemoteItem(cfg, "task-done", { blockerId: "task-gate-acceptance" });
  assert.strictEqual(demoted.ok, true);
  assert.strictEqual(demoted.demoted, true);
  assert.match(demoted.note, /task-done rolled back done -> open; task-gate-acceptance now blocks task-done/);
  assert.strictEqual(statusOf("task-done"), "open");
  assert.ok(fs.existsSync(path.join(nodes, "dec-resolver.md")), "the resolver node is left standing — it is the evidence, not the verdict");
  assert.match(fs.readFileSync(path.join(nodes, "dec-resolver.md"), "utf8"), /type: resolves/, "and its edge is never retracted (this client has no edge-removal door)");

  // Nothing to roll back: the ordinary local-mode case, where the run only ever
  // `reported` and the item never left the queue at all.
  write("task-open", "open");
  const open = await sporCli.gateDemoteItem(cfg, "task-open", { blockerId: "task-gate-acceptance" });
  assert.deepStrictEqual([open.ok, open.demoted], [true, false]);
  assert.match(open.note, /not a claim of completion/, "a do-nothing demotion still SAYS so — a silent one reads exactly like a working one");
  assert.strictEqual(statusOf("task-open"), "open");

  // A person's decision to DROP the work is not a claim of completion.
  write("task-abandoned", "abandoned");
  const abandoned = await sporCli.gateDemoteItem(cfg, "task-abandoned");
  assert.deepStrictEqual([abandoned.ok, abandoned.demoted], [true, false], "a gate never reopens what a person deliberately dropped");
  assert.strictEqual(statusOf("task-abandoned"), "abandoned");

  // And a node it cannot read is a reported failure, not a silent no-op.
  const missing = await sporCli.gateDemoteItem(cfg, "task-nope");
  assert.strictEqual(missing.ok, false);
  assert.match(missing.reason, /could not be re-read/);

  // The escalation write can fail (an offline graph, an id collision), and the
  // demotion still runs — but it must not imply a blocker that does not exist.
  write("task-done-2", "done");
  fs.writeFileSync(
    path.join(nodes, "dec-resolver-2.md"),
    "---\nid: dec-resolver-2\ntype: decision\ntitle: Added bounded retry again\nsummary: Added bounded retry with backoff to the second sync worker, so a transient failure retries instead of dropping.\ndate: 2026-08-26\nedges:\n  - {type: resolves, to: task-done-2}\n---\n\nBody.\n"
  );
  const unblocked = await sporCli.gateDemoteItem(cfg, "task-done-2");
  assert.deepStrictEqual([unblocked.ok, unblocked.demoted], [true, true]);
  assert.match(unblocked.note, /nothing blocks task-done-2/, "the note says the blocker is missing rather than implying one");
  assert.strictEqual(statusOf("task-done-2"), "open");
});

// gatePromoteItem is gateDemoteItem's mirror (task-spor-integration-propose-
// mode): once a PR lands, the completion a park() rolled back is restored.
test("gatePromoteItem restores a demoted item's completion status — the type's own declared value, not a hardcoded 'done'", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-promote-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const write = (id, type, status) =>
    fs.writeFileSync(
      path.join(nodes, `${id}.md`),
      `---\nid: ${id}\ntype: ${type}\ntitle: Something\nsummary: A one-sentence summary that stands on its own for ${id}.\nstatus: ${status}\ndate: 2026-08-26\n---\n\nBody.\n`
    );
  const statusOf = (id) => /^status: (.+)$/m.exec(fs.readFileSync(path.join(nodes, `${id}.md`), "utf8"))[1];

  // The ordinary case: a task park() demoted to 'open' restores to 'done'.
  write("task-parked", "task", "open");
  const promoted = await sporCli.gatePromoteItem(cfg, "task-parked");
  assert.deepStrictEqual([promoted.ok, promoted.restored], [true, true]);
  assert.strictEqual(statusOf("task-parked"), "done");

  // An issue restores to 'resolved', not 'done' — the type's own vocabulary,
  // read through the LOCAL registry.
  write("issue-parked", "issue", "open");
  const issuePromoted = await sporCli.gatePromoteItem(cfg, "issue-parked");
  assert.deepStrictEqual([issuePromoted.ok, issuePromoted.restored], [true, true]);
  assert.strictEqual(statusOf("issue-parked"), "resolved");

  // A node NOT sitting at the demoted status is left alone — a person may
  // have moved on from it since, and there is no way to tell that apart from
  // a bare status field.
  write("task-abandoned", "task", "abandoned");
  const untouched = await sporCli.gatePromoteItem(cfg, "task-abandoned");
  assert.deepStrictEqual([untouched.ok, untouched.restored], [true, false]);
  assert.strictEqual(statusOf("task-abandoned"), "abandoned");

  const missing = await sporCli.gatePromoteItem(cfg, "task-nope");
  assert.strictEqual(missing.ok, false);
});

// The retry-convergence bug an adversarial review caught: checkProposal
// (integration-runner.js) writes the LANDED fact — which carries a `resolves`
// edge onto the tracking item — BEFORE calling `restore`, because
// task-cc-terminal-status-requires-resolver means the resolver has to exist
// before the tracking item's own status can validly flip terminal. That
// means a live resolving edge can exist for a beat (or, if `restore` then
// fails, indefinitely) before the tracking item is genuinely closed. Reading
// that edge as "already settled" (the ordinary gateApprovalState polarity)
// would let a failed restore attempt never retry — checkProposals must key
// its skip decision on the tracking item's own STATUS, and `restoreProposal`
// must close the tracking item even on a retry where gatePromoteItem finds
// the work item ALREADY promoted (restored: false is not nothing-to-do).
test("a proposal whose restore failed once is retried, not permanently stuck — blockerAlreadyClosed reads STATUS, not the resolving edge", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-proposal-retry-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const write = (id, front, body = "Body.") => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-26\n---\n${body}\n`);
  const statusOf = (id) => /^status: (.+)$/m.exec(fs.readFileSync(path.join(nodes, `${id}.md`), "utf8"))[1];

  write("task-proposed", "type: task\ntitle: Add bounded retry\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: open\n");
  write("task-integration-proposed-x", "type: task\ntitle: PR pending review\nsummary: The integration stage opened a PR for task-proposed; it lands automatically once the PR merges.\nstatus: open\nrequires: [human]\n");

  // Simulate exactly what checkProposal does the FIRST time: the landed fact
  // (carrying the resolving edge) lands, but restore fails right after —
  // e.g. a transient write error — so the tracking item's own status never
  // flips. gateWriteStatus/setStatusLocal is the low-level door; write the
  // fact by hand the same way checkProposal's real recordFact dep would.
  write(
    "art-merge-proposed-run1-landed-deadbeef",
    "type: artifact\ntitle: Integration landed\nsummary: The integration stage landed task-proposed via a merged PR.\nedges:\n  - {type: relates-to, to: task-proposed}\n  - {type: resolves, to: task-integration-proposed-x}\n"
  );

  // The resolving edge already exists, but the tracking item's STATUS is
  // still 'open' — blockerAlreadyClosed must say so is NOT closed (unlike the
  // resolving-edge-based gateApprovalState, which would already read
  // "approved" here).
  assert.strictEqual(await sporCli.blockerAlreadyClosed(cfg, "task-integration-proposed-x"), false);
  const approvalState = await sporCli.gateApprovalState(cfg, "task-integration-proposed-x");
  assert.strictEqual(approvalState.state, "approved", "the edge alone WOULD read approved — exactly the false signal blockerAlreadyClosed must not use");

  // A retry pass: restoreProposal must still close the tracking item even
  // though the work item is (in this run) not yet promoted either.
  const first = await sporCli.restoreProposal(cfg, { blockerId: "task-integration-proposed-x", nodeId: "task-proposed" });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(statusOf("task-proposed"), "done");
  assert.strictEqual(statusOf("task-integration-proposed-x"), "done");
  assert.strictEqual(await sporCli.blockerAlreadyClosed(cfg, "task-integration-proposed-x"), true);

  // And the SAME retry-convergence claim for the harder case: the work item
  // was ALREADY promoted by a prior attempt, but that attempt's own close
  // write failed, leaving the tracking item stranded open. gatePromoteItem
  // alone would report `restored: false` here (nothing to promote) — the fix
  // is that restoreProposal closes the tracking item anyway.
  write("task-proposed-2", "type: task\ntitle: Add bounded retry\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: done\n");
  write("task-integration-proposed-y", "type: task\ntitle: PR pending review\nsummary: The integration stage opened a PR for task-proposed-2; it lands automatically once the PR merges.\nstatus: open\nrequires: [human]\n");
  const alreadyPromoted = await sporCli.gatePromoteItem(cfg, "task-proposed-2");
  assert.deepStrictEqual([alreadyPromoted.ok, alreadyPromoted.restored], [true, false], "already at the completion value — nothing for THIS call to promote");
  const second = await sporCli.restoreProposal(cfg, { blockerId: "task-integration-proposed-y", nodeId: "task-proposed-2" });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(statusOf("task-integration-proposed-y"), "done", "closed even though restored:false — this is what makes the retry converge");
});

// The gate's demotion writes through the SAME local door `spor set-status`
// uses. That door reads a type's status enum from two different declaration
// sites — the declarative `status.vocabulary` (task/issue/question) and the
// older `fields.status.enum` (workflow/workflow-run, which declare only that) —
// and reading either one alone silently disarms the check for every type using
// the other.
test("the shared local status door reads BOTH status-enum declaration sites, so neither type family goes unchecked", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-setstatus-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });

  // `task` declares status.vocabulary.
  fs.writeFileSync(
    path.join(nodes, "task-vocab.md"),
    "---\nid: task-vocab\ntype: task\ntitle: Add bounded retry to the sync worker\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: open\ndate: 2026-08-26\n---\n\nBody.\n"
  );
  // `workflow-run` declares fields.status.enum and NO status.vocabulary.
  fs.writeFileSync(
    path.join(nodes, "run-enum.md"),
    "---\nid: run-enum\ntype: workflow-run\ntitle: A workflow run\nsummary: One run of the demo workflow, recorded so the status door has a fields.status.enum type to gate.\nstatus: running\ndate: 2026-08-26\n---\n\nBody.\n"
  );

  for (const [id, bogus, good] of [["task-vocab", "totally-bogus", "done"], ["run-enum", "totally-bogus", "succeeded"]]) {
    const refused = sporCli.setStatusLocal(cfg, id, bogus);
    assert.strictEqual(refused.ok, false, `${id}: an off-vocabulary status must be refused, not written`);
    assert.match(refused.reason, /not allowed for type/);
    assert.strictEqual(sporCli.setStatusLocal(cfg, id, good).ok, true, `${id}: and a declared one still lands`);
    assert.match(fs.readFileSync(path.join(nodes, `${id}.md`), "utf8"), new RegExp(`^status: ${good}$`, "m"));
  }

  // Membership is a VERBATIM compare: every declared value is lowercase, so a
  // shouted one is refused rather than passing the check and being written
  // through unchanged.
  assert.strictEqual(sporCli.setStatusLocal(cfg, "task-vocab", "DONE").ok, false);

  // A type that declares neither is unconstrained, exactly as before.
  fs.writeFileSync(
    path.join(nodes, "norm-free.md"),
    "---\nid: norm-free\ntype: norm\ntitle: A norm with no status enum\nsummary: A norm node, whose type declares no status vocabulary at all, so any status value is accepted.\nstatus: active\ndate: 2026-08-26\n---\n\nBody.\n"
  );
  assert.strictEqual(sporCli.setStatusLocal(cfg, "norm-free", "whatever").ok, true);
});

test("a gate-filed WORK NODE is fence-safe and fits the server's body cap", () => {
  const body = [
    "Findings:",
    "",
    "```",
    // A suite tail or a review report can contain its own fence; ours must not
    // close early and spill the rest into the body as prose.
    "```json\n{\"verdict\":\"changes_requested\"}\n```",
    "```",
    "",
    "x".repeat(40000), // unbounded by construction: 20 findings + evidence + cycles
  ].join("\n");
  const md = sporCli.buildGateWorkNode({
    id: "task-gate-demo",
    title: "Gate escalation — demo",
    summary: "A gate refused the demo item and it needs a person.",
    body,
    project: "demo",
    date: "2026-08-26",
    requiresHuman: true,
    edges: [{ type: "relates-to", to: "task-demo" }],
  });
  assert.ok(Buffer.byteLength(md, "utf8") <= 8192, `a node the server would reject wholesale is an escalation nobody is told about (${Buffer.byteLength(md, "utf8")} bytes)`);
  assert.match(md, /^id: task-gate-demo$/m, "the frontmatter survives the trim");
  assert.match(md, /^requires: \[human\]$/m);
  // A newline in a title or summary would truncate the node at the parser.
  const flattened = sporCli.buildGateWorkNode({
    id: "task-gate-demo",
    title: "Gate\nescalation",
    summary: "line one\nline two",
    body: "Body.",
    date: "2026-08-26",
  });
  assert.match(flattened, /^title: Gate escalation$/m);
  assert.match(flattened, /^summary: line one line two$/m);
});

test("a gate-filed id is keyed on the WHOLE triple, so two gates sharing a 24-char prefix cannot collide", () => {
  const a = sporCli.gateIdSuffix("approve", "security-approval-database-migration", "task-x", "run-1");
  const b = sporCli.gateIdSuffix("approve", "security-approval-database-schema", "task-x", "run-1");
  assert.notStrictEqual(a, b, "the readable prefix truncates at 24 chars; the identity must not");
  assert.strictEqual(a, sporCli.gateIdSuffix("approve", "security-approval-database-migration", "task-x", "run-1"), "and it is deterministic");
  assert.notStrictEqual(a, sporCli.gateIdSuffix("escalate", "security-approval-database-migration", "task-x", "run-1"));
  assert.notStrictEqual(a, sporCli.gateIdSuffix("approve", "security-approval-database-migration", "task-y", "run-1"));
  assert.notStrictEqual(a, sporCli.gateIdSuffix("approve", "security-approval-database-migration", "task-x", "run-2"));
  // The FACT id — written on every gate outcome, not just the filed items —
  // carries the same identity: two gates sharing a prefix must not record over
  // each other, which for a pass/fail pair would file the wrong verdict.
  assert.notStrictEqual(
    gateRunner.gateFactId("security-review-database-migration", "task-x", "run-1"),
    gateRunner.gateFactId("security-review-database-schema", "task-x", "run-1")
  );
});

test("writing a gate node twice is one node — but the same id with DIFFERENT content is refused, never adopted", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gatewrite-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const node = (summary) =>
    `---\nid: art-gate-demo-x-abcdef12\ntype: artifact\ntitle: Gate demo\nsummary: ${summary}\ndate: 2026-08-26\n---\n\nBody.\n`;
  const first = await sporCli.writeGateNode(cfg, "art-gate-demo-x-abcdef12", node("The demo gate passed on the change under judgement, and this records it."));
  assert.strictEqual(first.ok, true);
  const again = await sporCli.writeGateNode(cfg, "art-gate-demo-x-abcdef12", node("The demo gate passed on the change under judgement, and this records it."));
  assert.deepStrictEqual([again.ok, again.existing], [true, true]);
  const collision = await sporCli.writeGateNode(cfg, "art-gate-demo-x-abcdef12", node("Something else entirely happened here, and it is not the same fact at all."));
  assert.strictEqual(collision.ok, false, "adopting another gate's node silently is how an approved item passes a gate nobody read");
  assert.match(collision.reason, /already exists with different content/);

  // And a malformed node never reaches the local graph unvalidated.
  const bad = await sporCli.writeGateNode(cfg, "art-gate-bad", "not a node at all");
  assert.strictEqual(bad.ok, false);
});

test("issue-spor-gate-node-refile-date-collision: re-filing the same gate fact across a date boundary no-ops, it does not collide", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gatewrite-date-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const node = (date) =>
    `---\nid: art-gate-demo-y-abcdef12\ntype: artifact\ntitle: Gate demo\nsummary: The demo gate passed on the change under judgement, and this records it.\ndate: ${date}\n---\n\nBody.\n`;
  const first = await sporCli.writeGateNode(cfg, "art-gate-demo-y-abcdef12", node("2026-08-26"));
  assert.strictEqual(first.ok, true);
  // Same fact, minted the next day (a resumed pipeline or a re-gated run
  // picking the same deterministic id back up past midnight) — this must
  // read as the SAME fact, not a collision with different content.
  const nextDay = await sporCli.writeGateNode(cfg, "art-gate-demo-y-abcdef12", node("2026-08-27"));
  assert.deepStrictEqual([nextDay.ok, nextDay.existing], [true, true]);
  // The on-disk node still carries the date it was FIRST written with — a
  // later date-only re-file is a no-op, not an update.
  assert.match(fs.readFileSync(path.join(home, "nodes", "art-gate-demo-y-abcdef12.md"), "utf8"), /date: 2026-08-26/);

  // A genuinely different outcome on a different date is still a real
  // collision — the date normalization must not swallow real drift.
  const realCollision = await sporCli.writeGateNode(
    cfg,
    "art-gate-demo-y-abcdef12",
    `---\nid: art-gate-demo-y-abcdef12\ntype: artifact\ntitle: Gate demo\nsummary: Something else entirely happened here, and it is not the same fact at all.\ndate: 2026-08-27\n---\n\nBody.\n`
  );
  assert.strictEqual(realCollision.ok, false);
  assert.match(realCollision.reason, /already exists with different content/);
});

// The durable half of the resumption above: makeGateDeps keeps the per-gate
// progress on the pipeline's own RUN RECORD (`gate_progress`, keyed by the
// attempt's run key), which is what a later worker's makeGateDeps reads back.
test("makeGateDeps saves gate progress on the run record and reads it back — keyed to the attempt, so a re-gate starts clean", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-progress-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  fs.mkdirSync(dispatchRuns.dispatchRunDir(home), { recursive: true });
  const runId = "11111111-2222-3333-4444-555555555555";
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, runId).record, {
    run_id: runId, node_id: "task-p", state: "done", terminal_state: "resolved", terminal_enforced: true,
    created_at: new Date().toISOString(), gate_state: "running", gate_worker: "w1", gate_at: new Date().toISOString(),
  });
  const mk = (attempt) =>
    sporCli.makeGateDeps(cfg, {
      record: { node_id: "task-p", cwd: home },
      entry: { run_id: runId, node_id: "task-p", project: null, ...(attempt > 1 ? { attempt } : {}) },
      factory: { id: "factory-test" }, slug: null, passthrough: {}, warn: () => {}, log: () => {}, stopping: () => false, home,
      dispatch: async () => ({ ok: false, reason: "never" }),
    });
  const gate = { id: "review" };
  const first = mk(1);
  assert.strictEqual(await first.loadGateProgress({ gate }), null, "nothing saved yet");
  const progress = { fixes: 2, attempts: [{ verdict: "failed", detail: "a" }, { verdict: "failed", detail: "b" }], ledger: [{ id: "F1", severity: "blocking", status: "open", blocking: true, summary: "x", opened: 0 }], lastFix: { cycle: 1, runId: null, fromHead: "abc", toHead: null } };
  await first.saveGateProgress({ gate, progress });
  await first.saveGateProgress({ gate: { id: "acceptance" }, progress: { fixes: 0, attempts: [], ledger: [], lastFix: null } });
  const onDisk = dispatchRuns.readJson(dispatchRuns.runPaths(home, runId).record);
  assert.deepStrictEqual(Object.keys(onDisk.gate_progress.gates).sort(), ["acceptance", "review"], "one entry per gate, both kept");
  assert.strictEqual(onDisk.gate_state, "running", "the verdict fields are untouched");

  // A later worker's deps (same run, same attempt) read it back — and recover
  // the in-flight fix's run id from the stamp the fix closure wrote.
  dispatchRuns.stampGateState(home, runId, { gate_fix_run_id: "fix-run-77" });
  const later = mk(1);
  const back = await later.loadGateProgress({ gate });
  assert.strictEqual(back.fixes, 2);
  assert.deepStrictEqual(back.ledger.map((e) => e.id), ["F1"]);
  assert.strictEqual(back.attempts.length, 2);
  assert.strictEqual(back.lastFix.runId, "fix-run-77", "the fix run id lands on the resumed lastFix");

  // A re-gate is a NEW attempt: it must not inherit the first attempt's cycles.
  assert.strictEqual(await mk(2).loadGateProgress({ gate }), null);
  // A settled record refuses the write (stampGateState's guard) and the dep
  // says so, which the runner logs and survives.
  dispatchRuns.stampGateState(home, runId, { gate_state: "failed" });
  await assert.rejects(() => first.saveGateProgress({ gate, progress }), /could not be updated/);
  fs.rmSync(home, { recursive: true, force: true });
});

// --------------------------------------------------- stop-during-fix-cycle --
// issue-spor-work-stop-abandons-inflight-gates: a fix cycle's own run is
// DETACHED and can be dispatched for up to a day (runMaxMs) before its
// makeGateDeps `fix` closure's awaitGateRun ever gives up on it — so a worker
// stopped while that await is in flight abandons the whole pipeline with no
// record of which child run it left running. The fix stamps `gate_fix_run_id`
// onto the PIPELINE's own run record the moment the fix cycle is dispatched —
// before the long wait, not after — so an interrupted record already names
// the orphan by the time any stop could land.
test("a fix cycle's run id is stamped onto the pipeline's own run BEFORE the long await, not after", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-fix-orphan-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  fs.mkdirSync(dispatchRuns.dispatchRunDir(home), { recursive: true });

  const runId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  dispatchRuns.atomicJson(dispatchRuns.runPaths(home, runId).record, {
    run_id: runId, node_id: "task-fix-me", state: "done", terminal_state: "resolved", terminal_enforced: true,
    created_at: new Date().toISOString(), gate_state: "running", gate_worker: "w1", gate_at: new Date().toISOString(),
  });

  const dispatchCalls = [];
  const deps = sporCli.makeGateDeps(cfg, {
    record: { node_id: "task-fix-me", cwd: home },
    entry: { run_id: runId, node_id: "task-fix-me", project: null },
    factory: { id: "factory-test" },
    slug: null,
    passthrough: {},
    warn: () => {},
    log: () => {},
    runMaxMs: 200, // the fix's own awaitGateRun gives up quickly — nothing here waits on the run terminating
    stopping: () => false,
    home,
    dispatch: async (_cfg, values) => {
      dispatchCalls.push(values);
      // A run record that reads NON-terminal, exactly like a real fix-cycle
      // dispatch's supervised run while its harness is still working — this is
      // what keeps awaitGateRun actually polling (not resolving on its very
      // first check) so there is a real mid-flight window to observe.
      dispatchRuns.atomicJson(dispatchRuns.runPaths(home, "fix-run-orphan").record, {
        run_id: "fix-run-orphan", node_id: "task-fix-me", state: "running", created_at: new Date().toISOString(),
      });
      return { ok: true, run: { run_id: "fix-run-orphan", harness: "fake" } };
    },
    // A plain timer so awaitGateRun's own poll loop can actually reach its
    // (short) deadline instead of hanging the test.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  const fixOutcome = deps.fix({ gate: { id: "acceptance" }, cycle: 0, findings: [], detail: "the suite fails", evidence: "" });
  // Give the dispatch + stamp their microtasks — this is the moment a stop
  // would land in real life, well before the fix cycle's own run ever
  // terminates: fixOutcome is still pending, its awaitGateRun still polling a
  // run record that reads "running" until the short runMaxMs gives up on it.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(dispatchCalls.length, "the fix cycle was actually dispatched by this point");

  const midFlight = dispatchRuns.readJson(dispatchRuns.runPaths(home, runId).record);
  assert.strictEqual(midFlight.gate_fix_run_id, "fix-run-orphan", "the fix cycle's run id lands on the PIPELINE's own run before its await settles");
  assert.ok(midFlight.gate_fix_at, "and it is dated");
  assert.strictEqual(dispatchCalls[0].node, "task-fix-me");
  assert.strictEqual(dispatchCalls[0].force, true);

  // Simulate the stop: work-loop.js's runWorkLoop marks the pipeline's own run
  // interrupted on the way out (lib/shell/work-loop.js, the final `if
  // (status.gating.length)` block) — via the exact same stampGateState door.
  const interrupted = dispatchRuns.stampGateState(home, runId, { gate_state: "interrupted" });
  assert.strictEqual(interrupted.gate_state, "interrupted");
  assert.strictEqual(
    interrupted.gate_fix_run_id,
    "fix-run-orphan",
    "the interrupted record still names the orphaned fix-cycle run — what a restarted 'spor work' or a human ('spor runs') finds it by"
  );

  // Let the fix's own promise settle (a missing run record reads as terminal
  // with no verdict — awaitGateRun does not hang on it) so the test leaves no
  // dangling handle. Its outcome is irrelevant to what this test checks: the
  // stamp above already landed before this point, which is the whole claim.
  await fixOutcome;
});

// ------------------------------------------------------------------- the CLI --

const HARNESS = "gatefake";

function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("SPOR_") || key.startsWith("SUBSTRATE_") || key === "XDG_CONFIG_HOME") continue;
    env[key] = value;
  }
  return { ...env, SPOR_FAKE_AGENTS_JSON: "[]", ...extra };
}

function cli(args, env, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env: cleanEnv(env), encoding: "utf8", timeout: 120000 });
}

// A scratch graph home holding one ready task, a fake harness profile, and a
// factory definition (plus one shareable gate node it references).
function cliFixture({ factoryPayload, gatePayload = null, factoryStatus = "active", gateStatus = "active" } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-home-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const repo = repoWithBranch({ weakenTest: false, regress: false });
  const write = (id, front, body) => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-26\n---\n${body}\n`);
  write(
    "task-ready",
    "type: task\nrepo: demo\ntitle: Add bounded retry to the sync worker\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: open\nedges:\n  - {type: assigned, to: agent-gatebox, profile: profile-gate}\n",
    "Add bounded retry to the sync worker."
  );
  write("agent-gatebox", "type: agent\ntitle: The gate test box\nsummary: An agent identity for the gate-pipeline test fixture.\n", "Test agent.");
  write("profile-gate", `type: profile\ntitle: Gate test profile\nsummary: A profile selecting the fake harness the gate-pipeline test declares locally.\nharness: ${HARNESS}\n`, "Test profile.");
  if (factoryPayload) {
    write(
      "factory-demo",
      `type: factory\ntitle: The demo factory\nsummary: The gate pipeline the demo project enforces between claim and resolve.\nstatus: ${factoryStatus}\n`,
      ["```json", JSON.stringify(factoryPayload, null, 2), "```"].join("\n")
    );
  }
  if (gatePayload) {
    write(
      "gate-shared",
      `type: gate\ntitle: A shared gate\nsummary: A shareable gate node the demo factory references by id.\nstatus: ${gateStatus}\n`,
      ["```json", JSON.stringify(gatePayload, null, 2), "```"].join("\n")
    );
  }
  const stub = writeSpawnableNodeStub(home, "gate-stub", `
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.GATE_OUTFILE, JSON.stringify({ cwd: process.cwd(), prompt }) + "\\n");
  process.stdout.write(JSON.stringify({ kind: "message", message: { text: "fake worker report" } }) + "\\n");
  process.exit(0);
});
`);
  fs.writeFileSync(
    path.join(home, "config.json"),
    `${JSON.stringify(
      {
        dispatch: {
          repos: { demo: repo },
          harness: { [HARNESS]: { command: stub, args: ["--dir={cwd}"], label: "Gate Fake", report: { from: "lastText", text: "message.text" } } },
        },
      },
      null,
      2
    )}\n`
  );
  return { home, repo, nodes, outfile: path.join(home, "invocations.jsonl") };
}

const OK_FACTORY = {
  factory: "demo",
  trusted_ref: "main",
  protected_paths: ["test/**"],
  test_lane_profile: "profile-test-writer",
  gates: [{ id: "acceptance", kind: "command", command: `"${process.execPath}" test/acceptance.js` }],
};

test("spor work --print names the factory and its gates, inline and referenced alike", () => {
  const { home, outfile } = cliFixture({
    factoryPayload: { ...OK_FACTORY, gates: [...OK_FACTORY.gates, { ref: "gate-shared" }] },
    gatePayload: { id: "adversarial", kind: "agent-review", profile: "profile-review", cycles: 2 },
  });
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, GATE_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() };
  const r = cli(["work", "--print", "--factory", "factory-demo"], env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /factory: factory-demo — trusted ref main, protected test\/\*\* -> profile-test-writer/);
  assert.match(r.stdout, /gate acceptance {2}command/);
  assert.match(r.stdout, /gate adversarial {2}agent-review {2}review under profile-review {2}\(up to 2 fix cycles\) {2}\[gate-shared\]/);

  // And with no factory the preview says so rather than implying gates.
  const bare = cli(["work", "--print"], env);
  assert.match(bare.stdout, /factory: none — the loop runs bare/);
});

test("a factory that does not validate REFUSES to start the worker — it never runs ungated", () => {
  for (const [payload, re] of [
    [{ ...OK_FACTORY, gates: [{ id: "x", kind: "command" }] }, /needs a 'command'/],
    [{ ...OK_FACTORY, gates: [{ ref: "gate-missing" }] }, /gate-missing/],
    [{ ...OK_FACTORY, test_lane_profile: "" }, /no separate lane to route to/],
  ]) {
    const { home, outfile } = cliFixture({ factoryPayload: payload });
    const r = cli(["work", "--once", "--factory", "factory-demo"], {
      SPOR_HOME: home,
      XDG_CONFIG_HOME: home,
      GATE_OUTFILE: outfile,
      PATH: pathWithOnlyGitAndNode(),
    });
    assert.strictEqual(r.status, 1, r.stdout);
    assert.match(r.stderr, re);
    assert.match(r.stderr, /does not run ungated/);
    assert.ok(!fs.existsSync(outfile), "and nothing was dispatched");
  }
});

test("a retired factory refuses to start the worker instead of silently continuing to enforce", () => {
  const { home } = cliFixture({ factoryPayload: OK_FACTORY, factoryStatus: "retired" });
  const r = cli(["work", "--once", "--factory", "factory-demo"], { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /'factory-demo' is 'retired', not 'status: active'/);
});

test("a retired gate referenced by an active factory is a load-time validation failure", () => {
  const { home } = cliFixture({
    factoryPayload: { ...OK_FACTORY, gates: [...OK_FACTORY.gates, { ref: "gate-shared" }] },
    gatePayload: { id: "adversarial", kind: "agent-review", profile: "profile-review", cycles: 2 },
    gateStatus: "retired",
  });
  const r = cli(["work", "--once", "--factory", "factory-demo"], { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /referenced gate 'gate-shared' is 'retired', not 'status: active'/);
  // The status error is the whole story — no misleading "could not be read"
  // duplicate from the gate resolver, which would send an operator debugging
  // the wrong thing (issue-spor-factory-definition-status-ignored review).
  assert.doesNotMatch(r.stderr, /could not be read from the graph/);
});

test("a factory id that is not a factory node says so, and points at the candidate schema", () => {
  const { home } = cliFixture({ factoryPayload: OK_FACTORY });
  const r = cli(["work", "--once", "--factory", "task-ready"], { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /is a 'task' node, not a 'type: factory' definition/);
  assert.match(r.stderr, /spor schema adopt schema-factory/);

  const missing = cli(["work", "--once", "--factory", "factory-nope"], { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() });
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /could not be read from the graph/);
});

// task-spor-agent-review-gate-satisfiability-precheck: an agent-review gate's
// verdict is read off the dispatched run's own final report, which only a
// SUPERVISED harness writes — a native-background launch (claude --bg, the
// default when a profile names no harness at all) has none. That mismatch
// used to surface only once a worker claimed the item and the review came
// back with nothing to parse; it must now refuse the worker at LOAD time.
test("an agent-review gate routed to a native-background profile refuses the worker at load time", () => {
  for (const [front, label] of [
    ["type: profile\ntitle: Native background profile\nsummary: A profile that names no harness at all.\n", "unset harness (defaults to claude-code)"],
    ["type: profile\ntitle: Explicit claude-code profile\nsummary: A profile that explicitly names the native-background built-in.\nharness: claude-code\n", "explicit claude-code"],
    // gate.profile pointing at a real node that is NOT `type: profile` (a
    // mistyped id, or a profile authored with no `type:` line at all) must
    // still be caught: neither resolveDispatchProfile nor spor dispatch's own
    // harness resolution checks the node's type, so this precheck must not
    // either — a `type:` mismatch here would silently fall back to run-time-
    // only detection for a plausible authoring mistake.
    ["type: task\ntitle: Not actually a profile node\nsummary: A node with the right id but the wrong type, and no harness field.\n", "wrong node type, no type:profile gate"],
  ]) {
    const { home, nodes } = cliFixture({
      factoryPayload: { ...OK_FACTORY, gates: [...OK_FACTORY.gates, { id: "review", kind: "agent-review", profile: "profile-native" }] },
    });
    fs.writeFileSync(path.join(nodes, "profile-native.md"), `---\nid: profile-native\n${front}date: 2026-08-26\n---\nTest profile.\n`);
    const r = cli(["work", "--once", "--factory", "factory-demo"], { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() });
    assert.strictEqual(r.status, 1, `${label}: ${r.stdout}`);
    assert.match(r.stderr, /gate 'review': agent-review gate routes to profile 'profile-native'/, label);
    assert.match(r.stderr, /launches native-background and has no report channel/, label);
    assert.match(r.stderr, /only a SUPERVISED harness writes/, label);
    assert.match(r.stderr, /does not run ungated/, label);
  }
});

test("an agent-review gate routed to a supervised (declared) harness loads cleanly", () => {
  // profile-gate (written by cliFixture) declares the fake harness the fixture
  // registers in dispatch.harness — always launchMode supervised-jsonl by v1
  // scope (lib/shell/dispatch-harnesses.js declaredAdapter) — so it must NOT
  // trip the native-background precheck.
  const { home } = cliFixture({
    factoryPayload: { ...OK_FACTORY, gates: [...OK_FACTORY.gates, { id: "review", kind: "agent-review", profile: "profile-gate" }] },
  });
  const r = cli(["work", "--print", "--factory", "factory-demo"], { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /gate review {2}agent-review {2}review under profile-gate/);
});

test("end to end: a dispatched run is gated, and the gate outcome lands in the graph as a fact on the item", () => {
  const { home, repo, nodes, outfile } = cliFixture({ factoryPayload: OK_FACTORY });
  const r = cli(
    ["work", "--once", "--max", "1", "--interval", "1", "--no-brief", "--no-worktree", "--factory", "factory-demo"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home, GATE_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() }
  );
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /work: dispatched task-ready/);
  assert.match(r.stdout, /task-ready — running the gate pipeline/);
  assert.match(r.stdout, /gate acceptance passed on task-ready/);
  assert.match(r.stdout, /work: gates — passed 1/);
  // The deliverable: a graph fact, linked to the work item, in the scratch home.
  const facts = fs.readdirSync(nodes).filter((f) => f.startsWith("art-gate-acceptance-ready-"));
  assert.strictEqual(facts.length, 1, `expected one gate fact, saw ${fs.readdirSync(nodes)}`);
  const body = fs.readFileSync(path.join(nodes, facts[0]), "utf8");
  assert.match(body, /- \{type: relates-to, to: task-ready\}/);
  assert.match(body, /passed/);
  assert.ok(fs.existsSync(path.join(repo, "test", "acceptance.js")), "the gate left the repo alone");
  assert.strictEqual(
    execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" }).trim().split("\n").length,
    1,
    "and cleaned up its gate worktree"
  );
});

test("end to end: an armed human gate files a requires:[human] approval item and BLOCKS the resolve", () => {
  const { home, nodes, outfile } = cliFixture({
    factoryPayload: {
      ...OK_FACTORY,
      risk_classes: { "touches:lib": ["lib/**"] },
      // approval_timeout_ms 0: the runner files the item, finds it unanswered,
      // and reports BLOCKED rather than deciding on the person's behalf.
      gates: [{ id: "security", kind: "human", risk: ["touches:lib"], approval_timeout_ms: 0 }],
    },
  });
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, GATE_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() };
  const r = cli(["work", "--once", "--max", "1", "--interval", "1", "--no-brief", "--no-worktree", "--factory", "factory-demo"], env);
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /work: gates — passed 0, failed 0, blocked 1/);
  const approval = fs.readdirSync(nodes).find((f) => f.startsWith("task-approve-security-ready-"));
  assert.ok(approval, `expected an approval item, saw ${fs.readdirSync(nodes)}`);
  const body = fs.readFileSync(path.join(nodes, approval), "utf8");
  assert.match(body, /requires: \[human\]/);
  assert.match(body, /- \{type: blocks, to: task-ready\}/, "an unanswered approval BLOCKS the gated item on the graph, not just in this box's cooldown map");
  assert.match(body, /touches:lib/, "the item names the risk class that armed the gate");
  assert.match(body, /spor set-status .* abandoned/, "and how to refuse it");
  // Blocked is not approved: the item is cooled, not treated as done.
  assert.match(cli(["work", "--status"], env).stdout, /skipped:\s+task-ready — gate pipeline blocked/);
});

test("end to end: a failing gate cools the item, files an escalation, and says so in --status", () => {
  const { home, nodes, outfile } = cliFixture({
    factoryPayload: { ...OK_FACTORY, gates: [{ id: "acceptance", kind: "command", command: `"${process.execPath}" -e "process.exit(1)"` }] },
  });
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, GATE_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() };
  const r = cli(["work", "--once", "--max", "1", "--interval", "1", "--no-brief", "--no-worktree", "--factory", "factory-demo"], env);
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /work: gates — passed 0, failed 1/);
  // The demotion is really wired through the CLI, not just through the fakes:
  // the escalation the gate filed now blocks the gated item on the graph. (The
  // fixture's item never went to a completion status, so there is no status to
  // roll back — the `blocks` half is the whole demotion here.)
  assert.match(r.stdout, /gate acceptance failed on task-ready.*now blocks task-ready/);
  const filed = fs.readdirSync(nodes);
  const escalation = filed.find((f) => f.startsWith("task-gate-acceptance-ready-"));
  assert.ok(escalation, `expected a human escalation item, saw ${filed}`);
  const body = fs.readFileSync(path.join(nodes, escalation), "utf8");
  assert.match(body, /requires: \[human\]/, "the escalation is a person's item — no worker can claim it");
  assert.match(body, /- \{type: blocks, to: task-ready\}/, "the refusal is durable graph state: the escalation blocks the gated item");

  const status = cli(["work", "--status"], env);
  assert.match(status.stdout, /gates:\s+factory-demo — passed 0, failed 1/);
  assert.match(status.stdout, /skipped:\s+task-ready — gate pipeline failed/);
});

// end to end: SIGTERM mid fix-cycle (issue-spor-work-stop-abandons-inflight-
// gates). A real `spor work` process, no --once — it must keep running until
// stopped. The declared harness answers a plain dispatch immediately but HANGS
// on a fix-cycle dispatch (recognized by its prompt), so the worker gets stuck
// mid-`awaitGateRun` exactly like an implementer that is still working when a
// service manager sends SIGTERM. Two things this must be true of: the worker
// actually EXITS on the first signal instead of sitting on the abandoned
// pipeline's own live timer, and the run record it leaves behind names the
// fix-cycle run it walked away from.
test("a single SIGTERM mid fix-cycle stops the worker promptly and leaves a durable record naming the orphaned run", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-stop-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const repo = repoWithBranch({ weakenTest: false, regress: false }); // benign diff — the command below fails regardless of it
  const write = (id, front, body) => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-08-26\n---\n${body}\n`);
  write(
    "task-ready",
    "type: task\nrepo: demo\ntitle: Add bounded retry to the sync worker\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: open\nedges:\n  - {type: assigned, to: agent-gatebox, profile: profile-gate}\n",
    "Add bounded retry to the sync worker."
  );
  write("agent-gatebox", "type: agent\ntitle: The gate test box\nsummary: An agent identity for the gate-pipeline test fixture.\n", "Test agent.");
  write("profile-gate", `type: profile\ntitle: Gate test profile\nsummary: A profile selecting the fake harness the gate-pipeline test declares locally.\nharness: ${HARNESS}\n`, "Test profile.");
  write(
    "factory-demo",
    "type: factory\ntitle: The demo factory\nsummary: The gate pipeline the demo project enforces between claim and resolve.\nstatus: active\n",
    [
      "```json",
      JSON.stringify({
        factory: "demo", trusted_ref: "main", protected_paths: ["test/**"], test_lane_profile: "profile-test-writer",
        // Always fails, regardless of the diff — this only exists to force
        // exactly one fix-cycle dispatch, never to be satisfied.
        gates: [{ id: "acceptance", kind: "command", command: `"${process.execPath}" -e "process.exit(1)"`, cycles: 1 }],
      }),
      "```",
    ].join("\n")
  );

  const outfile = path.join(home, "invocations.jsonl");
  // A plain dispatch (the initial claim) answers immediately, as every other
  // fixture's stub does. A FIX-CYCLE dispatch — its prompt names the gate that
  // refused the resolution (makeGateDeps' `fix`, bin/spor.js) — never answers:
  // it self-exits after a few seconds purely so this test does not leak a
  // process, but that is well past when this test has already killed the
  // worker and made its assertions.
  const stub = writeSpawnableNodeStub(
    home,
    "gate-stub",
    `
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.GATE_OUTFILE, JSON.stringify({ cwd: process.cwd(), prompt }) + "\\n");
  if (prompt.includes("gate refused your resolution")) { setTimeout(() => process.exit(0), 5000); return; }
  process.stdout.write(JSON.stringify({ kind: "message", message: { text: "fake worker report" } }) + "\\n");
  process.exit(0);
});
`
  );
  fs.writeFileSync(
    path.join(home, "config.json"),
    `${JSON.stringify(
      {
        dispatch: {
          repos: { demo: repo },
          harness: { [HARNESS]: { command: stub, args: ["--dir={cwd}"], label: "Gate Fake", report: { from: "lastText", text: "message.text" } } },
        },
      },
      null,
      2
    )}\n`
  );

  const env = cleanEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, GATE_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() });
  const child = spawn(process.execPath, [CLI, "work", "--interval", "1", "--no-brief", "--no-worktree", "--factory", "factory-demo"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (c) => (stdout += c));
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));

  try {
    // Wait for the fix cycle to actually be dispatched (two harness
    // invocations recorded: the initial claim, then the fix).
    const deadline = Date.now() + 20000;
    for (;;) {
      const n = fs.existsSync(outfile) ? fs.readFileSync(outfile, "utf8").split("\n").filter(Boolean).length : 0;
      if (n >= 2) break;
      if (Date.now() > deadline) throw new Error(`timed out waiting for the fix cycle to dispatch.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    // ...and that the pipeline's own run record already names it — the stamp
    // this feature adds, landing well before this worker is ever asked to stop.
    const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
    let named = null;
    for (;;) {
      const records = dispatchRuns.readRunRecords(home).filter((r) => r.node_id === "task-ready");
      named = records.find((r) => r.gate_fix_run_id);
      if (named) break;
      if (Date.now() > deadline) throw new Error(`timed out waiting for gate_fix_run_id to be stamped.\nrecords: ${JSON.stringify(records)}\nstdout:\n${stdout}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const fixRunId = named.gate_fix_run_id;

    child.kill("SIGTERM");
    // "close", not "exit" — "exit" can fire before the child's stdio pipes have
    // finished delivering their buffered data to this process (Node's own
    // docs), and the assertion right below reads the accumulated `stdout`.
    const exitCode = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 15000);
      child.on("close", (code) => {
        clearTimeout(t);
        resolve(code);
      });
    });
    assert.strictEqual(exitCode, 0, `a single SIGTERM must actually end the worker, even mid fix-cycle, not leave it running on the abandoned pipeline's own timer.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.match(stdout, new RegExp(`gate pipeline abandoned by the stop.*fix cycle \\(run ${fixRunId.slice(0, 8)}\\)`), "the abandon log names the orphaned fix-cycle run");

    // The durable record: interrupted, and still naming the run it left going.
    const finalRecord = dispatchRuns.readRunRecords(home).find((r) => r.run_id === named.run_id);
    assert.strictEqual(finalRecord.gate_state, "interrupted");
    assert.strictEqual(finalRecord.gate_fix_run_id, fixRunId, "the interrupted record still names the orphaned fix-cycle run");

    // A restarted `spor runs` surfaces both — the pipeline's own interrupted
    // state and the fix cycle it named — without needing --json.
    const runs = cli(["runs"], env);
    assert.match(runs.stdout, /gate:\s+interrupted/);
    assert.match(runs.stdout, new RegExp(`fix cycle:\\s+run ${fixRunId.slice(0, 8)}`));
  } finally {
    // Best-effort cleanup: the fix-cycle harness self-exits after 5s regardless,
    // but do not leave the worker (if somehow still alive) or its child around
    // for the rest of the suite.
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

// ------------------------------------------------------ empty diff, fail closed --
// issue-spor-review-gate-empty-diff-vacuous-pass: the first live factory run's
// implementer landed its commit on main itself, so the review gate diffed a
// commit against itself, dispatched a reviewer at nothing, and read back a
// pass. A review with nothing to judge must fail closed, unretried.

test("an agent-review gate with an EMPTY diff fails closed — no reviewer dispatched, no fix cycle, straight to a person", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "review", kind: "agent-review", profile: "profile-reviewer", cycles: 3 }] });
  const { deps, seen } = fakes({ changed: [] });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.match(res.reason, /no committed change against main/);
  assert.match(res.reason, /fails closed/);
  assert.strictEqual(seen.reviews.length, 0, "a reviewer is never dispatched at an empty diff");
  assert.strictEqual(seen.fixes.length, 0, "no fix cycle can produce a diff where the branch carries none");
  assert.strictEqual(seen.escalations.length, 1, "a person is asked why the branch is empty");
  assert.strictEqual(seen.demotions.length, 1);
});

test("a command gate is NOT the empty-diff guard — an unchanged tree still runs its suite (the review gate is where a vacuous pass would launder)", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test" }] });
  const { deps, seen } = fakes({ changed: [] });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(seen.suites, ["acceptance"]);
});

// ------------------------------------------------- the gate tree's setup hook --
// A bare `git worktree add` lacks whatever the repo's suite needs that is not in
// git (spor-server's node_modules symlink, a pinned sibling checkout). The gate
// tree is staged by the caller's `setup` hook — the repo's own
// dispatch.worktreeSetup on the CLI path — or the suite would fail on a missing
// dependency on a tree the implementer never touched.

test("prepareGateTree runs the caller's setup hook AFTER forcing the protected paths, and a failing hook refuses the tree", () => {
  const repo = repoWithBranch({ weakenTest: true, regress: false });
  const change = gateRunner.gateChangeSet({ cwd: repo }, "main");
  assert.strictEqual(change.ok, true, change.reason);
  const seen = [];
  const tree = gateRunner.prepareGateTree(change, {
    trustedRef: "main",
    protectedPaths: ["test/**"],
    setup: (dir) => {
      // By the time the hook runs, the protected path is already the trusted copy.
      seen.push(fs.readFileSync(path.join(dir, "test", "acceptance.js"), "utf8"));
      fs.writeFileSync(path.join(dir, "staged.txt"), "hook ran\n");
      return { ok: true };
    },
  });
  assert.strictEqual(tree.ok, true, tree.reason);
  assert.match(seen[0], /add is broken/, "the hook saw the TRUSTED suite, not the branch's weakened one");
  assert.strictEqual(fs.readFileSync(path.join(tree.dir, "staged.txt"), "utf8"), "hook ran\n");
  tree.cleanup();

  const refused = gateRunner.prepareGateTree(change, { trustedRef: "main", protectedPaths: [], setup: () => ({ ok: false, reason: "no node_modules upstream" }) });
  assert.strictEqual(refused.ok, false);
  assert.match(refused.reason, /no node_modules upstream/);
  const thrown = gateRunner.prepareGateTree(change, { trustedRef: "main", protectedPaths: [], setup: () => { throw new Error("boom"); } });
  assert.strictEqual(thrown.ok, false);
  assert.match(thrown.reason, /threw: boom/);
  assert.strictEqual(git(repo, "worktree", "list").trim().split("\n").length, 1, "a refused tree leaves no worktree behind");
});

test("runGateCommand layers the caller's env UNDER the gate's own CI/SPOR_GATE", async () => {
  const gate = { id: "envgate", command: `"${process.execPath}" -e "process.exit(process.env.EXTRA === '1' && process.env.SPOR_GATE === 'envgate' && process.env.CI === '1' ? 0 : 3)"`, timeoutMs: 20000 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-env-"));
  const r = await gateRunner.runGateCommand(gate, dir, { env: { EXTRA: "1", SPOR_GATE: "overridden" } });
  assert.strictEqual(r.ok, true, r.reason);
});

test("end to end: the gate tree is staged with the repo's own dispatch.worktreeSetup hook, and the dispatched prompt carries the worker contract", () => {
  const { home, repo, outfile } = cliFixture({ factoryPayload: OK_FACTORY });
  // The repo declares a setup hook (committed, relative path — the shape
  // spor-server ships) that stages a file the acceptance suite requires.
  const hookLog = path.join(home, "hook.log");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(repo, "scripts", "stage.sh"), '#!/bin/sh\nprintf "%s %s\\n" "$SPOR_MAIN_CHECKOUT" "$SPOR_TREE_ROLE" >> "$HOOK_LOG"\n: > "$SPOR_WORKTREE/staged.txt"\n');
  fs.writeFileSync(path.join(repo, "scripts", "unstage.sh"), '#!/bin/sh\nprintf "teardown %s %s\\n" "$SPOR_TREE_ROLE" "$SPOR_DISPATCH_NODE" >> "$HOOK_LOG"\n');
  fs.chmodSync(path.join(repo, "scripts", "stage.sh"), 0o755);
  fs.chmodSync(path.join(repo, "scripts", "unstage.sh"), 0o755);
  fs.writeFileSync(path.join(repo, ".spor.json"), JSON.stringify({ enabled: true, dispatch: { worktreeSetup: "scripts/stage.sh", worktreeTeardown: "scripts/unstage.sh" } }));
  // The suite needs the hook's staging AND reads what it is judging from the
  // env (task-spor-gate-command-change-env): base and head must be real shas
  // it can diff inside the tree, the trusted ref its name, the stage "gate".
  fs.writeFileSync(
    path.join(repo, "test", "acceptance.js"),
    [
      'const fs = require("fs");',
      'const cp = require("child_process");',
      'if (!fs.existsSync("staged.txt")) { console.error("not staged: the suite needs the hook"); process.exit(1); }',
      'const { SPOR_GATE_BASE: base, SPOR_GATE_HEAD: head, SPOR_TRUSTED_REF: ref, SPOR_GATE_STAGE: stage, SPOR_GATE_NODE: node } = process.env;',
      'if (!/^[0-9a-f]{40}$/.test(base || "") || !/^[0-9a-f]{40}$/.test(head || "")) { console.error("no base/head sha in env"); process.exit(2); }',
      'if (ref !== "main" || stage !== "gate" || node !== "task-ready") { console.error("bad ref/stage/node: " + [ref, stage, node]); process.exit(3); }',
      'const changed = cp.execSync(`git diff --name-only ${base}..${head}`).toString().trim();',
      'if (!changed.includes("lib/sub.js")) { console.error("the diff in env does not name the change: " + changed); process.exit(4); }',
      "",
    ].join("\n")
  );
  // Committed on MAIN (the trusted ref — the suite is a protected path, so it
  // must come from there), then merged into the implementer's branch so the
  // branch carries the hook and the marker but no protected-path edit of its own.
  git(repo, "stash", "-q", "--include-untracked");
  git(repo, "checkout", "-q", "main");
  git(repo, "stash", "pop", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "declare the setup hook and a suite that needs it");
  git(repo, "checkout", "-q", "impl");
  git(repo, "merge", "-q", "--no-edit", "main");
  const r = cli(
    ["work", "--once", "--max", "1", "--interval", "1", "--no-brief", "--no-worktree", "--factory", "factory-demo"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home, GATE_OUTFILE: outfile, HOOK_LOG: hookLog, PATH: pathWithOnlyGitAndNode() }
  );
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /gate acceptance passed on task-ready/, "the suite passed only because the hook staged the tree");
  const ran = fs.readFileSync(hookLog, "utf8").trim().split("\n");
  assert.strictEqual(ran.length, 2, `setup then teardown (saw ${ran})`);
  assert.match(ran[0], / gate$/, `the setup hook was told the role (saw ${ran[0]})`);
  assert.strictEqual(ran[1], "teardown gate task-ready", "the teardown hook ran once, told the role and the node");
  assert.strictEqual(fs.realpathSync(ran[0].split(" ")[0]), fs.realpathSync(repo), "SPOR_MAIN_CHECKOUT is the durable main checkout");
  assert.ok(!fs.existsSync(path.join(repo, "staged.txt")), "the hook staged the throwaway tree, never the repo itself");
  // The implementer got the contract as its task text.
  const invocation = JSON.parse(fs.readFileSync(outfile, "utf8").trim().split("\n")[0]);
  assert.match(invocation.prompt, /Work on task-ready/);
  assert.match(invocation.prompt, /## Worker contract/);
  assert.match(invocation.prompt, /Do NOT edit the protected test paths \(`test\/\*\*`\)/);
  assert.match(invocation.prompt, /`profile-test-writer` lane/);
  assert.match(invocation.prompt, /Resolve the item on the graph LAST/);
});

// ---------------------------------------------- evidence that names the failure --
// The first spor-server factory escalation carried 2.5KB of green checks and an
// nx footer ("server:test failed") — the failing test itself had scrolled out of
// the tail. Evidence for a failed suite leads with the failure lines.

test("failureEvidence pulls the failure lines out of a long, mostly-green suite output, then the tail", () => {
  const E = String.fromCharCode(27);
  const out = [
    "✔ a (1ms)",
    `${E}[31m✖ the one that broke (3ms)${E}[39m`,
    "  AssertionError [ERR_ASSERTION]: expected 1 got 2",
    ...Array(400).fill("✔ passing (1ms)"),
    `${E}[31m NX ${E}[39m  Running target test for 6 projects failed`,
    "Failed tasks:",
    "- server:test",
  ].join("\n");
  const e = gateRunner.failureEvidence(out);
  const lines = e.split("\n");
  assert.strictEqual(lines[0], "✖ the one that broke (3ms)", "ANSI stripped, failure first");
  assert.strictEqual(lines[1], "AssertionError [ERR_ASSERTION]: expected 1 got 2");
  assert.match(lines[2], /Running target test for 6 projects failed/);
  assert.match(e, /\n---\n/, "then the tail, separated");
  assert.ok(Buffer.byteLength(e, "utf8") <= 2600, `bounded, saw ${Buffer.byteLength(e, "utf8")}`);
  assert.ok(!e.split("\n---\n")[0].includes("✔"), "no passing line is picked up as a failure line, not even one whose title says failed");
  // Nothing matched: the plain tail, unchanged.
  assert.strictEqual(gateRunner.failureEvidence("all good\nfine"), "all good\nfine");
  assert.strictEqual(gateRunner.failureEvidence("✔ edge running -> failed (1ms)\nℹ pass 1"), "✔ edge running -> failed (1ms)\nℹ pass 1", "a passing title containing 'failed' is not a failure line");
});

test("a failed command gate's fact carries the failure lines, not just the tail", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test" }] });
  const output = ["✖ the broken one", ...Array(300).fill("✔ fine"), "Failed tasks:", "- server:test"].join("\n");
  const { deps, seen } = fakes({ suite: () => ({ ok: false, code: 1, output }) });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.match(seen.facts[0].markdown, /✖ the broken one/);
  assert.match(seen.escalations[0].evidence, /✖ the broken one/);
});

// -------------------------------------------------- spor work --regate <run> --
// A gate can refuse for a reason that is not the item's (a red trusted ref, a
// flaky suite). The fail-closed shape leaves the item demoted and blocked by
// an escalation, its work committed in a worktree, and — before this — no way
// back but redoing it. `--regate` re-judges the same run after the cause is
// fixed, under attempt-scoped ids, and undoes the refusal's graph state on a
// pass.

test("end to end: a run refused for an external cause is re-judged with --regate — new attempt-scoped facts, the escalation closed, nothing redone", () => {
  const { home, repo, nodes, outfile } = cliFixture({ factoryPayload: OK_FACTORY });
  // The trusted ref's suite is red for a reason outside the item (an env the
  // box lacks); the fix arrives later, outside the branch.
  fs.writeFileSync(path.join(repo, "test", "acceptance.js"), 'const fs = require("fs");\nif (!fs.existsSync("lib/fixed.js")) { console.error("✖ the trusted ref is red"); process.exit(1); }\n');
  git(repo, "checkout", "-q", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "a red trusted suite");
  git(repo, "checkout", "-q", "impl");
  git(repo, "merge", "-q", "--no-edit", "main");
  const env = { SPOR_HOME: home, XDG_CONFIG_HOME: home, GATE_OUTFILE: outfile, PATH: pathWithOnlyGitAndNode() };
  const first = cli(["work", "--once", "--max", "1", "--interval", "1", "--no-brief", "--no-worktree", "--factory", "factory-demo"], env);
  assert.strictEqual(first.status, 0, `${first.stderr}\n${first.stdout}`);
  assert.match(first.stdout, /gate acceptance failed on task-ready/);
  const runId = fs.readdirSync(path.join(home, "journal", "dispatch")).find((f) => f.endsWith(".run.json")).replace(".run.json", "");
  const recordPath = path.join(home, "journal", "dispatch", `${runId}.run.json`);
  const refused = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.strictEqual(refused.gate_state, "failed");
  assert.match(refused.gate_escalated_to, /^task-gate-acceptance-ready-/, "the loop stamps the escalation it filed onto the run record");
  const escalation = refused.gate_escalated_to;
  assert.ok(fs.existsSync(path.join(nodes, `${escalation}.md`)));
  const firstFacts = fs.readdirSync(nodes).filter((f) => f.startsWith("art-gate-acceptance-ready-"));
  assert.strictEqual(firstFacts.length, 1);

  // Refusals first: no such run; a run that is not a claim; no factory.
  const nope = cli(["work", "--regate", "deadbeef", "--factory", "factory-demo"], env);
  assert.strictEqual(nope.status, 1);
  assert.match(nope.stderr, /no run record matches 'deadbeef'/);
  const bare = cli(["work", "--regate", runId.slice(0, 8)], env);
  assert.strictEqual(bare.status, 1);
  assert.match(bare.stderr, /needs a factory/);

  // The cause is fixed on the TRUSTED REF, after the branch was cut — the
  // branch's own base is still red (issue-spor-command-gate-judges-stale-
  // branch-base), so the re-gate must merge main in before judging.
  git(repo, "checkout", "-q", "main");
  fs.writeFileSync(path.join(repo, "lib", "fixed.js"), "module.exports = true;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fix the trusted ref");
  git(repo, "checkout", "-q", "impl");
  const second = cli(["work", "--regate", runId.slice(0, 8), "--factory", "factory-demo"], env);
  assert.strictEqual(second.status, 0, `${second.stderr}\n${second.stdout}`);
  assert.match(second.stdout, /merged main \([0-9a-f]{8}\) into .* before re-gating/);
  assert.ok(execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", "main", "impl"], { encoding: "utf8" }) === "", "the branch now contains the trusted ref");
  assert.match(second.stdout, /re-gating task-ready — run [0-9a-f]{8}, attempt 2, under factory-demo \(previously failed/);
  assert.match(second.stdout, /gate acceptance passed on task-ready/);
  assert.match(second.stdout, new RegExp(`re-gate of task-ready passed — .*closed ${escalation} with art-regate-ready-[0-9a-f]{8}-r2-`));
  const facts = fs.readdirSync(nodes).filter((f) => f.startsWith("art-gate-acceptance-ready-"));
  assert.strictEqual(facts.length, 2, `the first verdict's fact stands beside the second's, saw ${facts}`);
  assert.ok(facts.some((f) => /-r2-/.test(f)), `the re-gate's fact is attempt-scoped: ${facts}`);
  const regate = fs.readdirSync(nodes).find((f) => f.startsWith("art-regate-ready-"));
  assert.ok(regate, "a resolving artifact was written for the escalation");
  assert.match(fs.readFileSync(path.join(nodes, regate), "utf8"), new RegExp(`- \\{type: resolves, to: ${escalation}\\}`));
  const after = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.strictEqual(after.gate_state, "passed", "the settled verdict on the record is the re-gate's");
  assert.strictEqual(after.gate_regate_count, 1);
  assert.match(after.gate_reason, /gate\(s\) passed/);
  assert.strictEqual(fs.readFileSync(path.join(nodes, "task-ready.md"), "utf8").includes("status: open"), true, "the stub never claimed completion, so nothing is promoted");
  assert.strictEqual(execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" }).trim().split("\n").length, 1, "the re-gate's tree is cleaned up");

  // A passed run is not re-judged again.
  const again = cli(["work", "--regate", runId.slice(0, 8), "--factory", "factory-demo"], env);
  assert.strictEqual(again.status, 1);
  assert.match(again.stderr, /already read 'passed'/);
});

test("stampGateState refuses to overwrite a settled verdict unless the caller is an explicit re-gate", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-gate-stamp-"));
  const dir = path.join(home, "journal", "dispatch");
  fs.mkdirSync(dir, { recursive: true });
  const id = "11111111-2222-3333-4444-555555555555";
  fs.writeFileSync(path.join(dir, `${id}.run.json`), JSON.stringify({ run_id: id, state: "done", gate_state: "failed", gate_reason: "red" }));
  const runs = require("../lib/shell/agent-dispatch-runner.js");
  runs.stampGateState(home, id, { gate_state: "running" });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, `${id}.run.json`), "utf8")).gate_state, "failed", "an ordinary stamp cannot launder a settled verdict");
  runs.stampGateState(home, id, { gate_state: "running", gate_regate_count: 1 }, { force: true });
  const after = JSON.parse(fs.readFileSync(path.join(dir, `${id}.run.json`), "utf8"));
  assert.strictEqual(after.gate_state, "running");
  assert.strictEqual(after.gate_regate_count, 1);
  assert.strictEqual(after.gate_reason, "red", "force only writes what it was given");
});


// --------------------------------- DB-backed gates: arming + serialize lease --
// A repo whose acceptance suite owns a singleton per box (a local database
// stack on a fixed port) needs two things a plain command gate lacks: a way
// to run only when the change warrants it, and a way to never run twice at
// once (task-spor-command-gate-risk-arming, task-spor-gate-serialize-lease).

test("a command gate parses `risk` and `serialize: repo`; an undeclared risk class or another scope refuses the factory", () => {
  const ok = gates.parseFactory(
    ["```json", JSON.stringify({ ...BASE, risk_classes: { "touches:db": ["db/**"] }, gates: [{ id: "rls", kind: "command", command: "make rls", risk: ["touches:db"], serialize: "repo" }] }), "```"].join("\n"),
    { id: "factory-test" }
  );
  assert.deepStrictEqual(ok.errors, []);
  assert.deepStrictEqual(ok.factory.gates[0].risk, ["touches:db"]);
  assert.strictEqual(ok.factory.gates[0].serialize, "repo");
  const plain = gates.parseFactory(["```json", JSON.stringify({ ...BASE, gates: [{ id: "a", kind: "command", command: "npm test" }] }), "```"].join("\n"), { id: "f" });
  assert.deepStrictEqual(plain.factory.gates[0].risk, []);
  assert.strictEqual(plain.factory.gates[0].serialize, null);
  const badRisk = gates.parseFactory(["```json", JSON.stringify({ ...BASE, gates: [{ id: "a", kind: "command", command: "x", risk: ["touches:nope"] }] }), "```"].join("\n"), { id: "f" });
  assert.ok(badRisk.errors.some((e) => /gate 'a': risk class 'touches:nope' is not declared/.test(e)), badRisk.errors.join("; "));
  assert.strictEqual(badRisk.factory, null);
  const badScope = gates.parseFactory(["```json", JSON.stringify({ ...BASE, gates: [{ id: "a", kind: "command", command: "x", serialize: "box" }] }), "```"].join("\n"), { id: "f" });
  assert.ok(badScope.errors.some((e) => /serialize 'box' must be 'repo'/.test(e)), badScope.errors.join("; "));
  assert.strictEqual(badScope.factory, null);
});

test("an UNARMED command gate is skipped — no suite runs, the fact says so, the pipeline continues", async () => {
  const factory = factoryOf({
    ...BASE,
    risk_classes: { "touches:db": ["db/**"] },
    gates: [
      { id: "rls", kind: "command", command: "make rls", risk: ["touches:db"] },
      { id: "unit", kind: "command", command: "npm test" },
    ],
  });
  const { deps, seen } = fakes({ changed: ["lib/x.js"] });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(res.gates.map((g) => [g.gate, g.verdict]), [["rls", "skipped"], ["unit", "passed"]]);
  assert.deepStrictEqual(seen.suites, ["unit"], "the DB suite never ran");
  assert.match(res.gates[0].detail, /no declared risk class \(touches:db\) was touched/);
  assert.strictEqual(seen.facts.length, 2, "the skip is still a recorded fact");
});

test("an ARMED command gate runs, names its class, and an unreadable change set still fails closed", async () => {
  const factory = factoryOf({ ...BASE, risk_classes: { "touches:db": ["db/**"] }, gates: [{ id: "rls", kind: "command", command: "make rls", risk: ["touches:db"] }] });
  const armed = fakes({ changed: ["db/migrations/1.sql"] });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: armed.deps });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(armed.seen.suites, ["rls"]);
  assert.match(res.gates[0].detail, /armed by touches:db/);
  const unreadable = fakes({ changed: null });
  const res2 = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: unreadable.deps });
  assert.strictEqual(res2.state, "failed", "no diff means no arming decision — fail closed, never skip");
});

test("a `serialize: repo` command gate takes the lease before its suite and releases it after — even when the suite throws", async () => {
  const factory = factoryOf({ ...BASE, gates: [{ id: "rls", kind: "command", command: "make rls", serialize: "repo" }, { id: "unit", kind: "command", command: "npm test" }] });
  const events = [];
  const mk = (suite) => {
    const { deps, seen } = fakes({ suite: (args) => { events.push(`suite:${args.gate.id}`); return suite(args); } });
    deps.acquireGateLease = async ({ gate }) => { events.push(`acquire:${gate.id}`); return { kind: "fake", gate: gate.id }; };
    deps.releaseGateLease = async (t) => { events.push(`release:${t.gate}`); };
    return { deps, seen };
  };
  await gateRunner.runGatePipeline({ item: ITEM, factory, deps: mk(() => ({ ok: true })).deps });
  assert.deepStrictEqual(events, ["acquire:rls", "suite:rls", "release:rls", "suite:unit"], "only the serialized gate touches the lease");
  events.length = 0;
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: mk(() => { throw new Error("db exploded"); }).deps });
  assert.strictEqual(res.state, "failed");
  assert.deepStrictEqual(events, ["acquire:rls", "suite:rls", "release:rls"], "released on a throw too");
  // No lease dep at all (a bare caller): the gate simply runs.
  events.length = 0;
  const bare = fakes({ suite: (args) => { events.push(`suite:${args.gate.id}`); return { ok: true }; } });
  await gateRunner.runGatePipeline({ item: ITEM, factory, deps: bare.deps });
  assert.deepStrictEqual(events, ["suite:rls", "suite:unit"]);
});

test("prepareGateTree runs the caller's teardown first thing in cleanup, and a throwing teardown never blocks the removal", () => {
  const repo = repoWithBranch({ weakenTest: false, regress: false });
  const change = gateRunner.gateChangeSet({ cwd: repo }, "main");
  const order = [];
  const tree = gateRunner.prepareGateTree(change, { trustedRef: "main", protectedPaths: [], setup: (d) => { order.push(`setup ${fs.existsSync(d)}`); return { ok: true }; }, teardown: (d) => { order.push(`teardown ${fs.existsSync(d)}`); throw new Error("boom"); } });
  assert.strictEqual(tree.ok, true, tree.reason);
  tree.cleanup();
  assert.deepStrictEqual(order, ["setup true", "teardown true"], "teardown sees the tree still there");
  assert.ok(!fs.existsSync(tree.dir), "the tree is gone despite the throwing teardown");
  assert.strictEqual(git(repo, "worktree", "list").trim().split("\n").length, 1);
});

// ------------------------------------------------ the stateful review prompt --
// task-spor-review-gate-stateful-bounded: what makeGateDeps' `review` actually
// hands the reviewer, against a real git checkout — the work item's text, the
// diff itself, and on a fix cycle the prior findings by ledger id and the fix
// cycle's commits — launched read-only. The verdict protocol is tested on the
// kernel; this pins the prompt that asks for it.
test("the review dispatch is read-only and carries the work item, the diff, the prior findings and the last fix's commits", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-review-prompt-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "nodes", "task-fix-me.md"),
    "---\nid: task-fix-me\ntype: task\ntitle: Make the bound exclusive\nsummary: The loop over-reads by one element.\nstatus: open\ndate: 2026-09-03\n---\n\nAcceptance: reading N items yields N.\n"
  );
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-review-repo-"));
  const g = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } }).trim();
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "x.js"), "module.exports = (n) => n;\n");
  g("add", "."); g("commit", "-q", "-m", "base");
  g("checkout", "-q", "-b", "task-fix-me");
  fs.writeFileSync(path.join(repo, "x.js"), "module.exports = (n) => n + 1;\n");
  g("commit", "-q", "-am", "implement");
  const head0 = g("rev-parse", "HEAD");

  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  fs.mkdirSync(dispatchRuns.dispatchRunDir(home), { recursive: true });
  const launches = [];
  let n = 0;
  const deps = sporCli.makeGateDeps(cfg, {
    record: { node_id: "task-fix-me", cwd: repo },
    entry: { run_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", node_id: "task-fix-me", project: null },
    factory: { id: "factory-test" },
    slug: null,
    passthrough: { sandbox: "danger-full-access" },
    warn: () => {}, log: () => {}, stopping: () => false, home,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    dispatch: async (_cfg, values, positionals) => {
      n += 1;
      const runId = `review-run-${n}`;
      const p = dispatchRuns.runPaths(home, runId);
      fs.writeFileSync(p.record.replace(/\.run\.json$/, ".report.md"), '```json\n{"verdict":"pass","prior":[{"id":"F1","status":"resolved"}]}\n```');
      dispatchRuns.atomicJson(p.record, { run_id: runId, node_id: "task-fix-me", state: "done", created_at: new Date().toISOString(), report_path: p.record.replace(/\.run\.json$/, ".report.md") });
      launches.push({ values, prompt: positionals[0] });
      return { ok: true, run: { run_id: runId, harness: "fake" } };
    },
  });
  const gate = { id: "adversarial-review", kind: "agent-review", profile: "profile-review", cycles: 2, awaitMs: 5000, instructions: "Hunt for off-by-ones." };

  assert.ok((await deps.changedPaths({ trustedRef: "main" })).ok);
  const first = await deps.review({ gate, cycle: 0, prior: [], fix: null });
  assert.strictEqual(first.ok, true, first.reason);
  assert.strictEqual(launches[0].values["read-only"], true, "the reviewer is launched read-only");
  assert.strictEqual(launches[0].values["no-worktree"], true);
  const p0 = launches[0].prompt;
  assert.match(p0, /\(the initial review\)/);
  assert.match(p0, /## The work item\n\ntask-fix-me: Make the bound exclusive\n\nThe loop over-reads by one element\.\n\nAcceptance: reading N items yields N\./, "the work item's title, summary and body are in the prompt");
  assert.match(p0, /```diff\n[\s\S]*-module\.exports = \(n\) => n;\n\+module\.exports = \(n\) => n \+ 1;/, "the diff itself is embedded");
  assert.match(p0, /Hunt for off-by-ones\./);
  assert.match(p0, /only `blocking` blocks/i);
  assert.match(p0, /"evidence": "the command\/test you ran and what it showed"/);
  assert.doesNotMatch(p0, /## Prior findings/, "no prior set on the initial review");
  assert.doesNotMatch(p0, /introduced_by_fix/, "attribution is only asked for on a fix cycle");

  // A fix cycle lands a commit; review 2 is handed the prior finding and that commit.
  fs.writeFileSync(path.join(repo, "x.js"), "module.exports = (n) => n;\n");
  g("commit", "-q", "-am", "fix F1: the bound is exclusive again");
  await deps.changedPaths({ trustedRef: "main" });
  const head1 = g("rev-parse", "HEAD");
  const prior = [{ id: "F1", severity: "blocking", file: "x.js", summary: "off by one", evidence: "node -e 'f(1)' prints 2" }];
  const second = await deps.review({ gate, cycle: 1, prior, fix: { cycle: 0, runId: "fix-run-1", fromHead: head0, toHead: head1, findings: [{ id: "F1", blocking: true }] } });
  assert.strictEqual(second.ok, true, second.reason);
  const p1 = launches[1].prompt;
  assert.match(p1, /\(the review after fix cycle 1 of 2\)/);
  assert.match(p1, /## Prior findings — answer these FIRST[\s\S]*F1 \[blocking\] x\.js — off by one\n    evidence: node -e 'f\(1\)' prints 2/);
  assert.match(p1, /## What the last fix cycle changed\n\nFix cycle 1 was dispatched as run fix-run-1 to address F1\./);
  assert.match(p1, /fix F1: the bound is exclusive again[\s\S]*x\.js \|/, "the fix's commit message and stat are in the prompt");
  assert.match(p1, /"prior": \[\{"id": "F1", "status": "resolved" \| "open"/);
  assert.match(p1, /"introduced_by_fix": true \| false/);
  assert.match(p1, /omits any prior finding \(neither cleared nor confirmed\) is UNREADABLE/);

  // And the fix prompt names the findings by id, splits advisory from blocking,
  // and lists what earlier cycles already resolved.
  let fixLaunch = null;
  const fixDeps = sporCli.makeGateDeps(cfg, {
    record: { node_id: "task-fix-me", cwd: repo }, entry: { run_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", node_id: "task-fix-me", project: null },
    factory: { id: "factory-test" }, slug: null, passthrough: {}, warn: () => {}, log: () => {}, stopping: () => false, home, runMaxMs: 50,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    dispatch: async (_cfg, values, positionals) => {
      fixLaunch = { values, prompt: positionals[0] };
      return { ok: true, run: { run_id: "fix-run-2", harness: "fake" } };
    },
  });
  await fixDeps.changedPaths({ trustedRef: "main" });
  await fixDeps.fix({
    gate, cycle: 1, detail: "the review requested changes — 1 blocking finding(s)",
    findings: [
      { id: "F2", severity: "blocking", file: "x.js", summary: "still over-reads on empty input", blocking: true, evidence: "node -e ..." },
      { id: "F3", severity: "major", file: "x.js", summary: "name the constant", blocking: false, note: null },
    ],
    ledger: [{ id: "F1", severity: "blocking", file: "x.js", summary: "off by one", status: "resolved", opened: 0, closed: 1 }],
  });
  assert.ok(fixLaunch, "the fix cycle was dispatched");
  assert.strictEqual(fixLaunch.values["read-only"], undefined, "the FIXER is not read-only");
  assert.match(fixLaunch.prompt, /\(fix cycle 2 of 2\)/);
  assert.match(fixLaunch.prompt, /Blocking findings — fix each, by id:\nF2 \[blocking\] x\.js — still over-reads on empty input/);
  assert.match(fixLaunch.prompt, /Advisory \(recorded, not enforced — fix if cheap\):\nF3 \[major\] x\.js — name the constant/);
  assert.match(fixLaunch.prompt, /Already resolved by earlier cycles \(do not regress\):\nF1 \[blocking\] x\.js — off by one/);
  assert.match(fixLaunch.prompt, /naming the finding ids you addressed in the commit message/);
});
