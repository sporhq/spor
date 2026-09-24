"use strict";
// Score a recorded set of Jev digest-intent decisions against a labeled corpus,
// with the SAME metrics and gate the Haiku classifier is held to (metrics.js).
//
//   node scripts/intent-eval/jev-score.js --labels <evalDir> --decisions <jev.jsonl>
//        [--qset server] [--threshold 0.5] [--budget 0.06] [--json OUT] [--strict]
//
// task-spor-digest-intent-jev-gate: the server half computes the verdict in
// /v1/digest (spor-server server/jev.js `digestIntent`) and the client honors
// it; this is the measurement that decides whether an UNSET digest.async honors
// it (prompt-context.js INTENT_GATE_DEFAULT). Jev is not callable from this
// public repo (its key lives in the tenant server,
// dec-spor-jev-calls-proxied-through-tenant-server), so the decisions are
// recorded out-of-band — one line per (case, qset): {case_id, qset,
// needs_history, digest_helps} — and this file only SCORES them, which makes
// every committed number re-derivable with no backend call.
//
// The rule is the one the server ships: the deterministic prompt heuristics
// the engine already applies (slash command, continuation, < 6 words — a
// FIRED case has passed them, so they only matter for a replay whose engine
// did not), THEN warranted = max(needs_history, digest_helps) >= threshold.
// A record with an error or a missing noul is NO VERDICT (fails the gate's
// integrity criterion, never silently counted as an inject).

const fs = require("fs");
const path = require("path");
const M = require("./metrics");
const pc = require("../engines/prompt-context");
const u = require("../engines/util");

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const LABELS = arg("labels", process.env.SPOR_INTENT_EVAL_LABELS);
const DECISIONS = arg("decisions", null);
const QSET = arg("qset", "server");
const THRESHOLD = parseFloat(arg("threshold", "0.5"));
const BUDGET = parseFloat(arg("budget", String(M.DEFAULT_BUDGET)));
const JSON_OUT = arg("json", null);
const STRICT = process.argv.includes("--strict");

function die(msg) {
  console.error(`jev-score: ${msg}`);
  process.exit(2);
}
const readJsonl = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function heuristicsPass(raw) {
  const p = pc.stripSystemReminders(raw ?? "");
  return !p.startsWith("/") && !pc.isContinuationPrompt(p) && u.wordCount(p) >= 6;
}

// The server's rule (exported for the unit test).
function jevVerdict(rec, prompt, threshold = 0.5) {
  if (!rec || rec.error) return null;
  const nh = rec.needs_history;
  const dh = rec.digest_helps;
  if (typeof nh !== "number" || typeof dh !== "number") return null;
  if (!heuristicsPass(prompt)) return "UNWARRANTED";
  return Math.max(nh, dh) >= threshold ? "WARRANTED" : "UNWARRANTED";
}

function main() {
  if (!LABELS) die("--labels <dir> is required");
  if (!DECISIONS) die("--decisions <jev.jsonl> is required");
  const judged = readJsonl(path.join(LABELS, "out", "judge-actual-vs-current.jsonl"));
  const replay = Object.fromEntries(readJsonl(path.join(LABELS, "out", "replay-current.jsonl")).map((r) => [r.case_id, r]));
  const cases = Object.fromEntries(readJsonl(path.join(LABELS, "cases", "cases.jsonl")).map((c) => [c.case_id, c]));
  const pop = M.selectPopulation({ judged, replay, caseIds: new Set(Object.keys(cases)) });

  // Last record per case wins (a resumed recording appends).
  const dec = {};
  for (const r of readJsonl(DECISIONS)) if (r.qset === QSET) dec[r.case_id] = r;

  const records = pop.fired.map((r) => {
    const verdict = jevVerdict(dec[r.case_id], cases[r.case_id].prompt, THRESHOLD);
    return {
      case_id: r.case_id,
      project_slug: r.project_slug,
      prompt_words: r.prompt_words,
      warranted: r.warranted,
      good: r.warranted && M.isGoodDigest(r),
      judgeVerdict: (r.b && r.b.verdict) ?? null,
      judgeScore: (r.b && r.b.score) ?? null,
      topSlot: (r.b && r.b.top_slot) ?? null,
      verdict,
      inject: verdict !== "UNWARRANTED",
      error: dec[r.case_id] ? dec[r.case_id].error ?? null : "no decision recorded",
    };
  });
  const score = M.scoreRun(records);
  const gate = M.gateVerdict(score, BUDGET, { population: pop.fired.length });
  const byId = Object.fromEntries(records.map((r) => [r.case_id, r]));
  const tables = {
    "current engine": M.fireRow(pop.userPrompt, pop.fires),
    "engine+jev": M.fireRow(pop.userPrompt, (id) => pop.fires(id) && (byId[id] ? byId[id].inject : true)),
  };
  const lat = Object.values(dec).map((r) => r.latency_ms).filter((x) => typeof x === "number").sort((a, b) => a - b);

  const pct = (x) => (x == null ? "n/a" : (x * 100).toFixed(1) + "%");
  const n3 = (x) => (x == null ? "n/a" : x.toFixed(3));
  console.log(`=== jev-score: qset=${QSET} threshold=${THRESHOLD} ===`);
  console.log(`corpus       : ${LABELS}`);
  console.log(`population   : ${score.n} fired user-prompt cases (${pop.labeled.length} judged; -${pop.notFired} fired no digest)`);
  console.log(`good digests lost   : ${score.goodLost}/${score.good}`);
  console.log(`warranted suppressed: ${score.suppressedW}/${score.firedW} (${pct(score.warrantedSuppression)})`);
  console.log(`noise removed       : ${score.suppressedU}/${score.firedU} (${pct(score.noiseRemoved)})`);
  console.log(`no verdict          : ${score.noVerdict}`);
  for (const [name, row] of Object.entries(tables)) {
    console.log(`  ${name.padEnd(16)} fire@warranted ${row.fireW}/${row.W}  fire@noise ${row.fireU}/${row.U}  F1=${n3(row.f1)}`);
  }
  if (lat.length) console.log(`latency median ${lat[Math.floor(lat.length / 2)]}ms  p90 ${lat[Math.floor(lat.length * 0.9)]}ms`);
  console.log(`VERDICT: gate ${gate.pass ? "PASS" : "FAIL"}`);
  if (score.suppressedW) console.log(`warranted suppressed ids: ${score.suppressedWIds.join(", ")}`);
  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ label: `jev-${QSET}`, qset: QSET, threshold: THRESHOLD, score, gate, tables }, null, 2) + "\n");
    console.log(`wrote ${JSON_OUT}`);
  }
  if (STRICT && !gate.pass) process.exit(1);
}

module.exports = { jevVerdict, heuristicsPass };
if (require.main === module) main();
