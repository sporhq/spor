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

// --- integrity: a run that measured nothing must never read as a passing one ---

test("scoreRun: a null verdict is a MISSING verdict, not a measured one", () => {
  // The classifier fails SILENTLY — classifyDigestIntent returns null both when
  // the backend died and when haiku answered ambiguously, and neither raises —
  // so these records carry no `error` field to count. Counting error strings
  // certified exactly the run the criterion exists to catch. The test is an
  // ALLOWLIST: only the two words the classifier is allowed to reach are a
  // decision, so there is no negative space to leak through.
  const recs = [
    { case_id: "1", warranted: true, good: false, inject: true, verdict: "WARRANTED" },
    { case_id: "2", warranted: true, good: false, inject: false, verdict: "UNWARRANTED" },
    { case_id: "3", warranted: true, good: false, inject: true, verdict: null }, // backend died / ambiguous
    { case_id: "4", warranted: true, good: false, inject: true, verdict: undefined },
    { case_id: "5", warranted: true, good: false, inject: true }, // no verdict key at all
    { case_id: "6", warranted: true, good: false, inject: true, verdict: "warranted" }, // a novel spelling
    { case_id: "7", warranted: true, good: false, inject: true, verdict: "WARRANTED", error: "spawn failed" },
  ];
  const s = m.scoreRun(recs);
  assert.strictEqual(s.noVerdict, 5);
  assert.deepStrictEqual(s.noVerdictIds, ["3", "4", "5", "6", "7"]);
  assert.strictEqual(m.hasVerdict(recs[0]), true);
  assert.strictEqual(m.hasVerdict(recs[6]), false, "an errored record carries no decision either");
});

test("gateVerdict: an all-failed run reads like a perfect one on harm alone — the integrity rule is what fails it", () => {
  // 77 dead backend calls: every case fails open to inject, so zero
  // suppressions, zero good digests lost, and a spotless harm/budget row.
  const score = { goodLost: 0, warrantedSuppression: 0, firedW: 59, n: 77, noVerdict: 77 };
  const g = m.gateVerdict(score, 0.06, { population: 77 });
  assert.strictEqual(g.harm.pass, true, "the harm numbers are perfect");
  assert.strictEqual(g.warranted.pass, true, "and so is the budget row");
  assert.strictEqual(g.integrity.pass, false);
  assert.strictEqual(g.integrity.value, 77);
  assert.strictEqual(g.pass, false, "a run that did not measure the classifier cannot pass a gate on it");
});

test("gateVerdict: a narrowed population cannot certify the classifier", () => {
  // The same arithmetic one level up: --limit/--only score a subset, and the
  // cases never looked at are exactly the ones that could have carried the
  // suppressions. `--limit 1` was otherwise a spotless PASS.
  const score = { goodLost: 0, warrantedSuppression: 0, firedW: 1, n: 1, noVerdict: 0 };
  const narrowed = m.gateVerdict(score, 0.06, { population: 77 });
  assert.strictEqual(narrowed.coverage.pass, false);
  assert.strictEqual(narrowed.coverage.value, 76);
  assert.strictEqual(narrowed.pass, false);

  const whole = m.gateVerdict({ ...score, n: 77 }, 0.06, { population: 77 });
  assert.strictEqual(whole.coverage.pass, true);
  assert.strictEqual(whole.pass, true);
});

test("gateVerdict: the integrity criteria fire only on a POSITIVE count", () => {
  // A caller handing a hand-built score (these tests, an archived JSON) must not
  // be failed for a field it never carried — the counting is guaranteed at its
  // source (scoreRun always emits noVerdict; run.js always passes the
  // population and the binding), not by punishing absence here.
  const g = m.gateVerdict({ goodLost: 0, warrantedSuppression: 0.05, firedW: 59 });
  assert.strictEqual(g.integrity.pass, true);
  assert.strictEqual(g.coverage.pass, true);
  assert.strictEqual(g.binding.pass, true);
  assert.strictEqual(g.pass, true);
});

// --- integrity: a measurement of one prompt must never be reported as another's ---

test("replayBinding: a replay is a replay OF A PROMPT", () => {
  const recs = (sha) => [{ template_sha: sha }, { template_sha: sha }];
  assert.strictEqual(m.replayBinding(recs("aaa"), "aaa").status, "bound");

  // The hazard: --template <candidate> --replay <shipped decisions> printed the
  // candidate's name and sha over the shipped prompt's answers.
  const mismatch = m.replayBinding(recs("aaa"), "bbb");
  assert.strictEqual(mismatch.status, "mismatch");
  assert.deepStrictEqual(mismatch.recorded, ["aaa"]);
  assert.strictEqual(mismatch.expected, "bbb");

  // Two prompts spliced into one file is not a run of either.
  assert.strictEqual(m.replayBinding([{ template_sha: "aaa" }, { template_sha: "bbb" }], "aaa").status, "mixed");
});

test("replayBinding: a record predating stamping is UNBOUND — scored, but it certifies nothing", () => {
  // Reproducing an old run is useful, so this is not a refusal; it is a gate
  // criterion, because decisions attached to no template cannot certify one.
  for (const missing of [{}, { template_sha: null }, { template_sha: "" }, { template_sha: 12 }]) {
    const b = m.replayBinding([{ template_sha: "aaa" }, missing], "aaa");
    assert.strictEqual(b.status, "unbound", `unbound for ${JSON.stringify(missing)}`);
    assert.strictEqual(b.unbound, 1);
  }
  const g = m.gateVerdict({ goodLost: 0, warrantedSuppression: 0, firedW: 59, n: 77, noVerdict: 0 }, 0.06, {
    population: 77,
    unbound: 1,
  });
  assert.strictEqual(g.binding.pass, false);
  assert.strictEqual(g.binding.value, 1);
  assert.strictEqual(g.pass, false, "one unbound decision is enough — the reported prompt is unevidenced");
});

// --- the committed evidence says FAIL, and says so in the suite, not only in prose ---

test("the committed runs record a FAILING gate, and their records name the prompt they scored", () => {
  // dec-spor-digest-intent-eval-harness-committed-rescored: NO prompt revision
  // scored inside budget. That is the finding this whole harness exists to
  // report, and prose can drift away from it (an earlier commit message on this
  // very branch says "the calibration gate is met"), so it is asserted here
  // against the artifacts themselves. If a future prompt DOES clear the budget,
  // this test is the place that has to be updated deliberately.
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(__dirname, "..", "scripts", "intent-eval", "runs");
  const runs = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(runs.length >= 2, "both scored prompts are committed");

  for (const f of runs) {
    const run = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.strictEqual(run.gate.pass, false, `${f}: the gate does not pass`);
    assert.strictEqual(run.gate.harm.pass, true, `${f}: it DOES clear the harm rule — a different claim`);
    assert.strictEqual(run.gate.warranted.pass, false, `${f}: the budget row is what fails`);
    assert.ok(run.score.warrantedSuppression > run.gate.budget, `${f}: over budget, not merely at it`);

    // Re-deriving the verdict from the recorded score reproduces the FAIL, so
    // the artifact's own `gate` block cannot have been hand-edited to a pass.
    const rederived = m.gateVerdict(run.score, run.gate.budget, { population: run.score.n });
    assert.strictEqual(rederived.pass, false, `${f}: re-derived verdict`);
    assert.strictEqual(rederived.warranted.pass, false);

    // Every decision in the paired record file names the template it came from
    // (see replayBinding) — a run file is otherwise attributable to any prompt.
    const jsonl = path.join(dir, f.replace(/\.json$/, ".jsonl"));
    const recs = fs.readFileSync(jsonl, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.strictEqual(recs.length, run.score.n, `${jsonl}: one record per scored case`);
    assert.strictEqual(m.replayBinding(recs, run.tplSha).status, "bound", `${jsonl}: bound to ${run.tplSha}`);
  }
});
