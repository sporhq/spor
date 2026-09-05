// scripts/intent-eval/metrics.js — the digest-intent classifier eval's scoring
// math and population selection (task-spor-recalibrate-digest-intent-prompt).
// The harness itself needs the private eval corpus and a backend, so it can't
// run here; these are the pure pieces, and they are the ones a wrong answer
// would silently ride on — the gate verdict is computed from them.
const test = require("node:test");
const assert = require("node:assert");
const m = require("../scripts/intent-eval/metrics.js");

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} !== ${b}`);
const arm = (over) => ({ verdict: "helpful", score: 5, top_slot: "relevant", ...over });
const judged = (id, warranted, b) => ({ case_id: id, warranted, a: arm(), b: arm(b) });

test("isGoodDigest: helpful/mixed, score >= 4, top slot relevant — all three", () => {
  assert.strictEqual(m.isGoodDigest(judged("x", true, {})), true);
  assert.strictEqual(m.isGoodDigest(judged("x", true, { verdict: "mixed" })), true);
  assert.strictEqual(m.isGoodDigest(judged("x", true, { verdict: "noisy" })), false);
  assert.strictEqual(m.isGoodDigest(judged("x", true, { score: 4 })), true, "4 is inside the bar");
  assert.strictEqual(m.isGoodDigest(judged("x", true, { score: 3 })), false);
  assert.strictEqual(m.isGoodDigest(judged("x", true, { top_slot: "tangential" })), false);
  assert.strictEqual(m.isGoodDigest(judged("x", true, { top_slot: "noise" })), false);
});

test("isGoodDigest: reads arm b (the replay the classifier is shown), not arm a", () => {
  // The classifier judges the CURRENT engine's digest, so the harm metric must
  // read the arm that digest was labeled on. Reading arm a — the live server
  // digest of the day — would score a different artifact than the one suppressed.
  const rec = { warranted: true, a: arm(), b: arm({ verdict: "noisy", score: 1, top_slot: "noise" }) };
  assert.strictEqual(m.isGoodDigest(rec), false);
  assert.strictEqual(m.isGoodDigest(rec, "a"), true);
  assert.strictEqual(m.isGoodDigest({}), false, "a record with no arm is not good");
});

test("selectPopulation: only cases where the engine FIRED reach the classifier", () => {
  const judgedSet = [
    judged("fired", true, {}),
    judged("dry", false, {}),
    judged("empty", true, {}),
    { case_id: "unlabeled" }, // no `warranted` key — never judged for the fire gate
  ];
  const replay = {
    fired: { fired: true, candidate_digest: "…" },
    dry: { fired: false, candidate_digest: null },
    empty: { fired: true, candidate_digest: "" }, // fired but produced nothing to classify
    unlabeled: { fired: true, candidate_digest: "…" },
  };
  const pop = m.selectPopulation({ judged: judgedSet, replay, caseIds: new Set(["fired", "dry", "empty", "unlabeled"]) });
  assert.deepStrictEqual(pop.fired.map((r) => r.case_id), ["fired"]);
  assert.strictEqual(pop.notFired, 2, "a dry case and an empty digest both never reach the classifier");
  assert.strictEqual(pop.labeled.length, 3, "the unlabeled case is out of the judged set entirely");
});

test("selectPopulation: headless backend personas are SKIPPED, never silently dropped", () => {
  // The 21 source=sdk/spor-server persona invocations are not user prompts and
  // are handled by a deterministic guard, not this classifier. They must leave
  // the scored population but stay countable, or the report would claim a
  // denominator it never explained.
  const judgedSet = [judged("user", true, {}), judged("persona", true, {})];
  const replay = { user: { fired: true, candidate_digest: "…" }, persona: { fired: true, candidate_digest: "…" } };
  const pop = m.selectPopulation({ judged: judgedSet, replay, caseIds: new Set(["user"]) });
  assert.deepStrictEqual(pop.fired.map((r) => r.case_id), ["user"]);
  assert.deepStrictEqual(pop.skipped.map((r) => r.case_id), ["persona"]);
  assert.deepStrictEqual(pop.userPrompt.map((r) => r.case_id), ["user"]);
});

test("scoreRun: harm counts are of SUPPRESSIONS, and a fail-open verdict is an inject", () => {
  const recs = [
    { case_id: "1", warranted: true, good: true, inject: true },
    { case_id: "2", warranted: true, good: true, inject: false }, // the harm case
    { case_id: "3", warranted: true, good: false, inject: false },
    { case_id: "4", warranted: false, good: false, inject: false }, // noise removed
    { case_id: "5", warranted: false, good: false, inject: true }, // noise let through
  ];
  const s = m.scoreRun(recs);
  assert.strictEqual(s.n, 5);
  assert.strictEqual(s.firedW, 3);
  assert.strictEqual(s.firedU, 2);
  assert.strictEqual(s.good, 2);
  assert.strictEqual(s.goodLost, 1);
  assert.deepStrictEqual(s.goodLostIds, ["2"]);
  assert.strictEqual(s.suppressedW, 2);
  assert.strictEqual(s.suppressedU, 1);
  close(s.warrantedSuppression, 2 / 3, "warranted suppression");
  close(s.goodLoss, 1 / 2, "good-digest loss");
  close(s.noiseRemoved, 1 / 2, "noise removed");
});

test("scoreRun: suppression scored as a noise detector (suppress = the positive class)", () => {
  const recs = [
    { case_id: "1", warranted: false, good: false, inject: false }, // tp
    { case_id: "2", warranted: false, good: false, inject: false }, // tp
    { case_id: "3", warranted: false, good: false, inject: true }, // fn
    { case_id: "4", warranted: true, good: false, inject: false }, // fp
    { case_id: "5", warranted: true, good: false, inject: true }, // tn
  ];
  const s = m.scoreRun(recs);
  close(s.precision, 2 / 3, "of what it suppressed, how much was truly noise");
  close(s.recall, 2 / 3, "of the noise, how much it suppressed");
  close(s.f1, 2 / 3, "f1");
});

test("scoreRun: a classifier that suppresses nothing has no harm AND buys nothing", () => {
  // The degenerate pass. It clears both gate criteria and is worth no backend
  // call, which is why `noiseRemoved` is reported beside them and not after.
  const recs = [
    { case_id: "1", warranted: true, good: true, inject: true },
    { case_id: "2", warranted: false, good: false, inject: true },
  ];
  const s = m.scoreRun(recs);
  assert.strictEqual(s.goodLost, 0);
  assert.strictEqual(s.warrantedSuppression, 0);
  assert.strictEqual(s.noiseRemoved, 0);
  assert.strictEqual(s.precision, null, "it never predicted the positive class");
});

test("fireRow: fire rates and F1 over the full population, fired and not", () => {
  const cases = [
    { case_id: "a", warranted: true },
    { case_id: "b", warranted: true },
    { case_id: "c", warranted: false },
    { case_id: "d", warranted: false },
  ];
  const row = m.fireRow(cases, (id) => id === "a" || id === "c");
  assert.strictEqual(row.W, 2);
  assert.strictEqual(row.U, 2);
  assert.strictEqual(row.fireW, 1);
  assert.strictEqual(row.fireU, 1);
  close(row.rateW, 0.5, "fire@warranted");
  close(row.rateU, 0.5, "fire@noise");
  close(row.f1, 0.5, "precision .5, recall .5");
  const perfect = m.fireRow(cases, (id) => id === "a" || id === "b");
  close(perfect.f1, 1, "fires on every warranted prompt and no noise");
});

test("gateVerdict: good-digest loss is the hard rule — one lost fails the gate", () => {
  const pass = m.gateVerdict({ goodLost: 0, warrantedSuppression: 0.05, firedW: 59 });
  assert.strictEqual(pass.harm.pass, true);
  assert.strictEqual(pass.warranted.pass, true);
  assert.strictEqual(pass.pass, true);

  // Under budget on the loose rate is NOT a pass when a good digest was lost:
  // that is the harm no fail-open path recovers.
  const harmed = m.gateVerdict({ goodLost: 1, warrantedSuppression: 0.02, firedW: 59 });
  assert.strictEqual(harmed.harm.pass, false);
  assert.strictEqual(harmed.pass, false);
});

test("gateVerdict: over budget by less than one case is flagged as the sample's resolution", () => {
  // 4/59 = 6.8% against a 6% budget. The overage (0.8pp) is smaller than one
  // case (1.7pp), so the report says so rather than presenting a precision the
  // sample cannot express. It is still not a pass.
  const g = m.gateVerdict({ goodLost: 0, warrantedSuppression: 4 / 59, firedW: 59 });
  assert.strictEqual(g.warranted.pass, false);
  assert.strictEqual(g.warranted.withinOneCase, true);
  assert.strictEqual(g.pass, false);
  close(g.oneCase, 1 / 59, "one case in the denominator");

  // Well over the budget is not excused by the same allowance.
  const bad = m.gateVerdict({ goodLost: 0, warrantedSuppression: 30 / 59, firedW: 59 });
  assert.strictEqual(bad.warranted.withinOneCase, false);
  assert.strictEqual(bad.pass, false);
});

test("gateVerdict: the budget is configurable, and the default is the design's ~6%", () => {
  assert.strictEqual(m.DEFAULT_BUDGET, 0.06);
  const g = m.gateVerdict({ goodLost: 0, warrantedSuppression: 4 / 59, firedW: 59 }, 0.08);
  assert.strictEqual(g.warranted.pass, true);
  assert.strictEqual(g.pass, true);
});
