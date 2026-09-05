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
//
// Both harm metrics COUNT SUPPRESSIONS, so every way of not getting a verdict —
// a dead backend, a child that printed nothing, a reply carrying both words or
// neither, a case absent from a replay file, a population narrowed by --limit —
// scores as an inject and moves them TOWARD passing. A run that measured
// nothing is therefore indistinguishable, on 1 and 2 alone, from a perfectly
// calibrated one. That is why the gate carries three further INTEGRITY criteria
// — every scored case carries a DECISION (`noVerdict === 0`), the scored set is
// the whole population (`uncovered === 0`), and every decision is bound to the
// template being reported (`unbound === 0`) — and why run.js refuses a replay
// that does not cover the population, or whose decisions were produced under a
// DIFFERENT prompt: an unmeasured case must never read as a passing one, and a
// measurement of one prompt must never be reported as another's.
//
// The decision test is a POSITIVE one. The classifier's failures are silent by
// design — `classifyDigestIntent` returns null both when the backend died and
// when haiku answered ambiguously, and neither raises — so a record whose
// verdict is null carries no `error` field to count. Counting error strings
// therefore certified exactly the run this criterion exists to catch: 77 dead
// backend calls score as 77 injects, zero suppressions, zero errors, and a
// spotless PASS. A case counts as measured only when it carries one of the two
// decisions the classifier is allowed to reach; every other shape — null,
// undefined, absent, a novel spelling, an errored record — is no verdict.

// A judged arm is "good" when the judge found the digest genuinely useful:
// helpful-or-mixed overall, scored >= 4, and its TOP slot relevant (the top
// slot is what a reader actually acts on). Arm `b` is the local replay of the
// CURRENT engine — the digest the classifier is shown — so it is the arm the
// harm metric reads; arm `a` is the live server digest of the day.
const GOOD_VERDICTS = new Set(["helpful", "mixed"]);
const GOOD_MIN_SCORE = 4;

// The only two answers that ARE a classification. See the header: an allowlist,
// because every other shape means the run did not measure this case.
const DECISIVE = new Set(["WARRANTED", "UNWARRANTED"]);

const hasVerdict = (r) => !r.error && DECISIVE.has(r.verdict);

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
  // Cases where no DECISION was obtained: a backend/harness failure (run.js
  // records an `error`), or a reply the shipped parse could not read as either
  // word (null verdict, no error — the silent majority). Production fails open
  // on both and so does the scoring, since they count as injects above; that is
  // exactly why they are counted here. They make the harm metrics look better,
  // so a run carrying any of them is not a measurement of the classifier.
  const noVerdict = records.filter((r) => !hasVerdict(r));

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
    noVerdict: noVerdict.length,
    noVerdictIds: noVerdict.map((r) => r.case_id),
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

// Which TEMPLATE a set of decisions was produced under. A record carries the
// sha of the template that was filled to obtain it (`template_sha`), because a
// replayed decision is otherwise unattached to any prompt: `--replay` reads a
// decision file while the template is resolved SEPARATELY from --template / the
// checkout, so `--template candidate.md --replay shipped.jsonl` scored one
// prompt's decisions and printed the other prompt's name and sha over them. The
// harness's whole claim is "this prompt scores X"; an unbound replay is a claim
// about nothing.
//
//   bound     every record carries the same sha and it IS the resolved one
//   mismatch  every record agrees, and it is a DIFFERENT template — the operator
//             named a prompt that did not produce these decisions (run.js
//             refuses: it is an unanswerable question, not a bad score)
//   mixed     the file splices decisions from two templates (same refusal)
//   unbound   one or more records predate stamping, so nothing ties them to any
//             template. Scored and printed — reproducing an old run is useful —
//             but it cannot certify a prompt, so the gate's `binding` criterion
//             counts the unbound records and rule 0 applies.
const UNBOUND = Symbol("unbound");

function replayBinding(records, expected) {
  const shas = new Set(records.map((r) => (r && typeof r.template_sha === "string" && r.template_sha ? r.template_sha : UNBOUND)));
  const unbound = records.filter((r) => !(r && typeof r.template_sha === "string" && r.template_sha)).length;
  const recorded = [...shas].filter((x) => x !== UNBOUND).sort();
  if (unbound > 0) return { status: "unbound", unbound, recorded, expected };
  if (recorded.length > 1) return { status: "mixed", unbound: 0, recorded, expected };
  if (recorded.length === 1 && recorded[0] !== expected) return { status: "mismatch", unbound: 0, recorded, expected };
  return { status: "bound", unbound: 0, recorded, expected };
}

// The pre-ship gate, as dec-spor-digest-intent-classifier-scored-prompt-recalibrated
// applied it. Five criteria, deliberately not one number:
//
//   goodLost === 0        the HARD rule. A digest the judge rated genuinely
//                         good must never be suppressed; that is the harm no
//                         fail-open path recovers.
//   warrantedSuppression  <= budget (default 6%, the async design's assumed
//                         empty-missed budget). `withinOneCase` reports whether
//                         the overage is smaller than one case (1.7pp at n=59)
//                         — the sample's RESOLUTION, printed on a FAILING
//                         criterion and never an excuse that flips it. Do not
//                         read it as "so it might really be under": two
//                         materially different prompts have now both measured
//                         4/59 here, on four DISJOINT cases (README Results),
//                         which is two draws agreeing on the rate rather than
//                         one draw that cannot resolve it.
//   noVerdict === 0       INTEGRITY, per case. Both metrics above count
//                         suppressions, so a case with no decision scores as an
//                         inject and pushes them toward passing — an all-failed
//                         run reads exactly like a perfect one. A run that did
//                         not measure the classifier cannot pass a gate on it.
//   uncovered === 0       INTEGRITY, per population. The same arithmetic one
//                         level up: a run narrowed by --limit/--only scores a
//                         SUBSET, and the cases it never looked at are exactly
//                         the ones that could have carried the suppressions.
//                         `--limit 1` is otherwise a spotless gate PASS.
//   unbound === 0         INTEGRITY, per PROMPT. The two above ask whether the
//                         classifier was measured; this one asks whether what
//                         was measured is the template being reported. A
//                         replayed decision that carries no `template_sha` is
//                         attached to no prompt, so scoring it certifies
//                         whichever template the report happened to resolve.
//                         (A decision bound to a DIFFERENT template never
//                         reaches the gate — run.js refuses that outright.)
//
// All three integrity criteria fire only on a POSITIVE count, so a caller that
// hands gateVerdict a hand-built score (the pure-math tests, an archived JSON)
// is not failed for a field it never carried. The counting itself is not
// optional there — it lives in scoreRun, which always emits `noVerdict`, and in
// run.js, which always passes the population it selected and the binding of the
// decisions it scored.
const DEFAULT_BUDGET = 0.06;

function gateVerdict(score, budget = DEFAULT_BUDGET, { population = null, unbound = 0 } = {}) {
  const oneCase = score.firedW > 0 ? 1 / score.firedW : null;
  const over = score.warrantedSuppression != null ? score.warrantedSuppression - budget : null;
  const noVerdict = score.noVerdict ?? 0;
  const uncovered = population != null && score.n != null ? population - score.n : 0;
  return {
    budget,
    oneCase,
    harm: { metric: "good digests lost", value: score.goodLost, pass: score.goodLost === 0 },
    integrity: { metric: "cases with no verdict", value: noVerdict, pass: !(noVerdict > 0) },
    coverage: { metric: "population cases not scored", value: uncovered, pass: !(uncovered > 0) },
    binding: {
      metric: "decisions not bound to prompt",
      value: unbound,
      pass: !(unbound > 0),
    },
    warranted: {
      metric: "warranted suppressed",
      value: score.warrantedSuppression,
      pass: over != null && over <= 0,
      // Inside one case of the budget: the rate is above it, but by less than
      // the resolution the sample can express.
      withinOneCase: over != null && over > 0 && oneCase != null && over <= oneCase,
    },
    pass:
      score.goodLost === 0 &&
      !(noVerdict > 0) &&
      !(uncovered > 0) &&
      !(unbound > 0) &&
      over != null &&
      over <= 0,
  };
}

module.exports = {
  GOOD_VERDICTS,
  GOOD_MIN_SCORE,
  DECISIVE,
  DEFAULT_BUDGET,
  hasVerdict,
  isGoodDigest,
  selectPopulation,
  replayBinding,
  scoreRun,
  fireRow,
  gateVerdict,
  rate,
};
