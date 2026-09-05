"use strict";
// Pure scoring math for the digest-intent classifier eval
// (scripts/intent-eval/run.js). No IO, no backend, no engine — kept separate so
// the arithmetic the gate verdict rests on is unit-testable without the private
// eval corpus and without spending a backend call (test/intent-metrics.test.js).
//
// The classifier's decision is BINARY and ASYMMETRIC (see the prompt itself):
// suppressing a digest that would have helped is much worse than injecting one
// that turns out marginal. So the numbers that matter are not accuracy — they
// are, in order:
//
//   1. good digests lost  — a WARRANTED prompt whose actual digest the judge
//      rated genuinely good, suppressed. This is the harm the async design's
//      fail-open premise cannot protect against (fail-open covers infra
//      failure, not a confident wrong UNWARRANTED), so the rule is ZERO.
//   2. warranted suppressed — the looser rate, against the ~6% budget
//      dec-spor-digest-async-intent-gate-implementation assumed.
//   3. noise removed — what the gate BUYS. A classifier that suppresses
//      nothing passes 1 and 2 trivially and is worth no backend call.

// A judged arm is "good" when the judge found the digest genuinely useful:
// helpful-or-mixed overall, scored >= 4, and its TOP slot relevant (the top
// slot is what a reader actually acts on). Arm `b` is the local replay of the
// CURRENT engine — the digest the classifier is shown — so it is the arm the
// harm metric reads; arm `a` is the live server digest of the day.
const GOOD_VERDICTS = new Set(["helpful", "mixed"]);
const GOOD_MIN_SCORE = 4;

function isGoodDigest(judged, arm = "b") {
  const a = judged && judged[arm];
  if (!a) return false;
  return GOOD_VERDICTS.has(a.verdict) && (a.score ?? 0) >= GOOD_MIN_SCORE && a.top_slot === "relevant";
}

// The population the classifier actually sees. It only ever runs on a FIRED
// digest (the engine spooled a micro-digest to classify), so a case is in scope
// only when the replay both fired and produced a candidate digest.
//
// `caseIds` is the re-extracted user-prompt case set: the judged set predates it
// and still holds `source=sdk` / spor-server headless backend-persona
// invocations, which are not user prompts and are handled by the separate
// deterministic guard (issue-spor-digest-fires-on-headless-backend-personas),
// not by this semantic classifier. They are reported as `skipped`, never
// silently dropped.
function selectPopulation({ judged, replay, caseIds }) {
  const fires = (id) => {
    const r = replay[id];
    return !!(r && r.fired && r.candidate_digest);
  };
  const labeled = judged.filter((r) => "warranted" in r);
  const firedAll = labeled.filter((r) => fires(r.case_id));
  return {
    fires,
    labeled,
    userPrompt: labeled.filter((r) => caseIds.has(r.case_id)),
    fired: firedAll.filter((r) => caseIds.has(r.case_id)),
    skipped: firedAll.filter((r) => !caseIds.has(r.case_id)),
    notFired: labeled.length - firedAll.length,
  };
}

const rate = (num, den) => (den > 0 ? num / den : null);

// Score one classifier run. `records` are one per fired case, carrying the
// judge's `warranted` label, whether the case's digest was `good`, and the
// EFFECTIVE decision `inject` (the worker injects on anything but an
// unambiguous UNWARRANTED, so a fail-open null verdict counts as inject here
// exactly as it does in production).
function scoreRun(records) {
  const firedW = records.filter((r) => r.warranted);
  const firedU = records.filter((r) => !r.warranted);
  const good = records.filter((r) => r.good);
  const suppressedW = firedW.filter((r) => !r.inject);
  const suppressedU = firedU.filter((r) => !r.inject);
  const goodLost = good.filter((r) => !r.inject);

  // Suppression as a noise DETECTOR: predicting "suppress" is the positive
  // class, so precision is "of what it suppressed, how much was truly noise".
  const tp = suppressedU.length;
  const fp = suppressedW.length;
  const fn = firedU.length - suppressedU.length;
  const precision = rate(tp, tp + fp);
  const recall = rate(tp, tp + fn);
  const f1 = precision != null && recall != null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : null;

  return {
    n: records.length,
    firedW: firedW.length,
    firedU: firedU.length,
    good: good.length,
    goodLost: goodLost.length,
    goodLostIds: goodLost.map((r) => r.case_id),
    suppressedW: suppressedW.length,
    suppressedWIds: suppressedW.map((r) => r.case_id),
    suppressedU: suppressedU.length,
    warrantedSuppression: rate(suppressedW.length, firedW.length),
    goodLoss: rate(goodLost.length, good.length),
    noiseRemoved: rate(suppressedU.length, firedU.length),
    precision,
    recall,
    f1,
  };
}

// One row of the full-population fire table: over EVERY judged user-prompt case
// (fired and not), how often does the surface fire on a warranted prompt vs on
// noise? This is the basis the min-sim sweep reported on, so the classifier's
// row is directly comparable to it — and to the current always-inject engine,
// which is the thing default-on would replace.
function fireRow(cases, fires) {
  const W = cases.filter((r) => r.warranted);
  const U = cases.filter((r) => !r.warranted);
  const fireW = W.filter((r) => fires(r.case_id)).length;
  const fireU = U.filter((r) => fires(r.case_id)).length;
  const recall = rate(fireW, W.length);
  const precision = rate(fireW, fireW + fireU);
  const f1 = precision != null && recall != null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : null;
  return { W: W.length, U: U.length, fireW, fireU, rateW: recall, rateU: rate(fireU, U.length), f1 };
}

// The pre-ship gate, as dec-spor-digest-intent-classifier-scored-prompt-recalibrated
// applied it. Two criteria, deliberately not one number:
//
//   goodLost === 0        the HARD rule. A digest the judge rated genuinely
//                         good must never be suppressed; that is the harm no
//                         fail-open path recovers.
//   warrantedSuppression  <= budget (default 6%, the async design's assumed
//                         empty-missed budget). Reported with the size of ONE
//                         case in the denominator, because at n=59 a single
//                         case moves the rate ~1.7pp and a verdict that reads
//                         "over budget" by less than that is measuring the
//                         sample, not the prompt.
const DEFAULT_BUDGET = 0.06;

function gateVerdict(score, budget = DEFAULT_BUDGET) {
  const oneCase = score.firedW > 0 ? 1 / score.firedW : null;
  const over = score.warrantedSuppression != null ? score.warrantedSuppression - budget : null;
  return {
    budget,
    oneCase,
    harm: { metric: "good digests lost", value: score.goodLost, pass: score.goodLost === 0 },
    warranted: {
      metric: "warranted suppressed",
      value: score.warrantedSuppression,
      pass: over != null && over <= 0,
      // Inside one case of the budget: the rate is above it, but by less than
      // the resolution the sample can express.
      withinOneCase: over != null && over > 0 && oneCase != null && over <= oneCase,
    },
    pass: score.goodLost === 0 && over != null && over <= 0,
  };
}

module.exports = {
  GOOD_VERDICTS,
  GOOD_MIN_SCORE,
  DEFAULT_BUDGET,
  isGoodDigest,
  selectPopulation,
  scoreRun,
  fireRow,
  gateVerdict,
  rate,
};
