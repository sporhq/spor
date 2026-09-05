"use strict";
// Fire-gate eval for the async digest-intent classifier — scores
// prompts/client/digest-intent.md against the judge's `warranted` labels
// (task-spor-recalibrate-digest-intent-prompt; the measured outcome is
// dec-spor-digest-intent-classifier-scored-prompt-recalibrated).
//
// This is the gate dec-spor-digest-async-intent-gate-implementation deferred:
// SPOR_DIGEST_ASYNC does not go default-on until the classifier is scored
// against these labels. The first run of it (2026-07-06) found the shipped
// prompt suppressed 51% of warranted digests, and the harness that produced
// that number lived in a scratchpad — so a later prompt edit had nothing to
// re-score against. This is that harness, committed.
//
//   node scripts/intent-eval/run.js --labels <evalDir> [--engine-root DIR]
//        [--template FILE] [--cmd "<backend>"] [--concurrency K] [--limit N]
//        [--only id,id] [--label NAME] [--out runs/<name>.jsonl] [--json OUT]
//        [--budget 0.06] [--strict]
//   node scripts/intent-eval/run.js --labels <evalDir> --replay <prior.jsonl>
//
// The corpus is NOT in this repo and cannot be: it is 7MB of real prompts and
// digests off a working box, and this repo is public. It lives in the private
// server repo (`evals/digest-intent-2026-07-06`) — see README.md.
//
// FIDELITY. The classifier is not re-implemented here. Each case fills the REAL
// template with the REAL (SLUG, PROMPT, DIGEST) and calls the shipped
// classifyDigestIntent through classify-one.js, so the backend selection, the
// timeout, the llm-calls record and the verdict parse are the shipping ones.
// The one deliberate substitution is the graph home: a scratch dir, never the
// live graph (norm: tests never write the live graph home).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const M = require("./metrics");

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes("--" + name);

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LABELS_DIR = arg("labels", process.env.SPOR_INTENT_EVAL_LABELS);
const ENGINE_ROOT = path.resolve(arg("engine-root", REPO_ROOT));
const LABEL = arg("label", "shipped");
const CMD = arg("cmd", ""); // "" = the shipped default backend (claude -p --model haiku)
const CONC = parseInt(arg("concurrency", "8"), 10);
const LIMIT = parseInt(arg("limit", "0"), 10);
// --only <id,id> scores a named handful, which is how you iterate on a prompt
// without spending the whole population on every edit. Like --limit it can only
// ever produce a SUB-population, and the gate's coverage criterion refuses to
// certify one — see M.gateVerdict.
const ONLY = arg("only", "");
// --template scores a candidate template file in place of the engine's shipped
// one. Only the TEXT is substituted: the fill, the backend, the timeout, the
// llm-calls record and the verdict parse all still come from the engine under
// test, so fidelity is unchanged (see the FIDELITY note above). Without it a
// candidate can only be scored from a whole second checkout, which is how the
// last one rotted unmeasured — candidates/ holds the ones already scored.
const TEMPLATE = arg("template", "");
const TIMEOUT = parseInt(arg("timeout", "60000"), 10);
const BUDGET = parseFloat(arg("budget", String(M.DEFAULT_BUDGET)));
const REPLAY = arg("replay", null);
const OUT = arg("out", null);
const JSON_OUT = arg("json", null);
const STRICT = flag("strict");

function die(msg) {
  console.error(`intent-eval: ${msg}`);
  process.exit(2);
}

const readJsonl = (file) =>
  fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// The shipped template fill, from the engine under test.
const u = require(path.join(ENGINE_ROOT, "scripts", "engines", "util.js"));

function classify(job) {
  return new Promise((resolve) => {
    // Scrub SPOR_*/SUBSTRATE_* from the child: a configured dev box would
    // otherwise resolve the engine into remote mode / the live graph home, and
    // the eval must be a pure function of (template, case). Everything else is
    // inherited, because the default backend is the real `claude` CLI and it
    // needs HOME and PATH to authenticate.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !/^(SPOR|SUBSTRATE)_/.test(k))
    );
    const child = spawn(process.execPath, [path.join(__dirname, "classify-one.js"), ENGINE_ROOT], {
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ verdict: null, inject: true, ms: 0, error: String(e.message || e) }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        // A child that died without printing is a harness failure, not a
        // classifier verdict — but it lands on the fail-open side (inject), the
        // same side production lands on, so it can never fake a noise win.
        resolve({ verdict: null, inject: true, ms: 0, error: "no verdict from child" });
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(job));
  });
}

async function pool(items, conc, fn) {
  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(conc, items.length)) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        results[i] = await fn(items[i], i);
        if (++done % 10 === 0) process.stderr.write(`  ${done}/${items.length}\n`);
      }
    })
  );
  return results;
}

// Backend spend, read back from the llm-calls journal the shipped classifier
// writes — the same records the nightly quality loop reads. This is the input
// to the cost half of the default-on decision (a flip puts one of these calls
// on every substantive prompt of every user), so the harness reports it rather
// than leaving it to be estimated.
function backendSpend(graph) {
  const dir = path.join(graph, "journal", "llm-calls");
  let recs = [];
  try {
    for (const f of fs.readdirSync(dir)) recs = recs.concat(readJsonl(path.join(dir, f)));
  } catch {
    return null;
  }
  const calls = recs.filter((r) => r.source === "digest-intent");
  if (!calls.length) return null;
  const costs = calls.map((r) => r.cost_usd).filter((c) => typeof c === "number");
  const lat = calls.map((r) => r.latency_ms).filter((x) => typeof x === "number").sort((a, b) => a - b);
  const inTok = calls.map((r) => r.usage && r.usage.input_tokens).filter((x) => typeof x === "number");
  const outTok = calls.map((r) => r.usage && r.usage.output_tokens).filter((x) => typeof x === "number");
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  return {
    calls: calls.length,
    failures: calls.filter((r) => r.error).length,
    costTotal: costs.length ? sum(costs) : null,
    costMean: costs.length ? sum(costs) / costs.length : null,
    latencyMedian: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    latencyP90: lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.9))] : null,
    inputTokensMean: inTok.length ? sum(inTok) / inTok.length : null,
    outputTokensMean: outTok.length ? sum(outTok) / outTok.length : null,
  };
}

const pct = (x) => (x == null || !Number.isFinite(x) ? "n/a" : (x * 100).toFixed(1) + "%");
const n3 = (x) => (x == null ? "n/a" : x.toFixed(3));

function report(records, score, gate, tables, spend, drops) {
  const verdicts = records.reduce((a, r) => ((a[String(r.verdict)] = (a[String(r.verdict)] ?? 0) + 1), a), {});

  console.log(`\n=== intent-eval: ${LABEL} ===`);
  console.log(`engine       : ${ENGINE_ROOT}`);
  console.log(`template     : ${drops.tplFile} (sha ${drops.tplSha})${TEMPLATE ? "   [candidate, not the shipped template]" : ""}`);
  console.log(`backend      : ${REPLAY ? `replay ${REPLAY}` : CMD ? `cmd:${CMD}` : "cli:claude -p --model haiku (shipped default)"}`);
  console.log(`corpus       : ${LABELS_DIR}`);
  console.log(
    `population   : ${score.n} fired user-prompt cases ` +
      `(${drops.judged} judged; -${drops.notFired} fired no digest, -${drops.skipped} headless backend personas)`
  );
  console.log(
    `verdicts     : ${JSON.stringify(verdicts)}  ` +
      `(null = ambiguous/failed -> worker FAILS OPEN to inject, and the gate counts it as NO VERDICT)`
  );

  console.log(`\n-- harm (the asymmetric side) --`);
  console.log(`  good digests lost   : ${score.goodLost}/${score.good}   (${pct(score.goodLoss)})`);
  console.log(`  warranted suppressed: ${score.suppressedW}/${score.firedW}   (${pct(score.warrantedSuppression)})`);
  console.log(`\n-- what the gate buys --`);
  console.log(`  noise removed       : ${score.suppressedU}/${score.firedU}   (${pct(score.noiseRemoved)})`);
  console.log(`  suppression as a noise detector: precision ${pct(score.precision)}  recall ${pct(score.recall)}  F1 ${n3(score.f1)}`);

  const rows = Object.entries(tables);
  console.log(`\n-- full user-prompt population fire table (W=${rows[0][1].W}, U=${rows[0][1].U}) --`);
  for (const [name, row] of rows) {
    console.log(
      `  ${name.padEnd(20)} fire@warranted ${row.fireW}/${row.W} (${pct(row.rateW)})   ` +
        `fire@noise ${row.fireU}/${row.U} (${pct(row.rateU)})   F1=${n3(row.f1)}`
    );
  }

  if (spend) {
    console.log(`\n-- backend spend (per classification; a default-on flip pays this on every substantive prompt) --`);
    console.log(
      `  calls ${spend.calls} (${spend.failures} failed)   ` +
        `cost/call ${spend.costMean == null ? "n/a" : "$" + spend.costMean.toFixed(5)}   ` +
        `total ${spend.costTotal == null ? "n/a" : "$" + spend.costTotal.toFixed(4)}`
    );
    console.log(
      `  latency median ${spend.latencyMedian}ms  p90 ${spend.latencyP90}ms   ` +
        `tokens in/out ${spend.inputTokensMean == null ? "n/a" : Math.round(spend.inputTokensMean)}/${spend.outputTokensMean == null ? "n/a" : Math.round(spend.outputTokensMean)}`
    );
  }

  console.log(`\n-- gate --`);
  console.log(
    `  ${gate.harm.metric.padEnd(27)}: ${score.goodLost}        rule: 0` +
      `                     ${gate.harm.pass ? "PASS" : "FAIL"}`
  );
  console.log(
    `  ${gate.integrity.metric.padEnd(27)}: ${gate.integrity.value}        rule: 0` +
      `                     ${gate.integrity.pass ? "PASS" : "FAIL"}` +
      (gate.integrity.pass ? "" : "  (a case with no decision scored as an inject — not a measurement)")
  );
  console.log(
    `  ${gate.coverage.metric.padEnd(27)}: ${gate.coverage.value}        rule: 0` +
      `                     ${gate.coverage.pass ? "PASS" : "FAIL"}` +
      (gate.coverage.pass ? "" : "  (a sub-population cannot certify the classifier)")
  );
  const note = gate.warranted.pass
    ? ""
    : gate.warranted.withinOneCase
      ? `  (over by less than one case = ${pct(gate.oneCase)} — a note on a FAILING criterion)`
      : "";
  console.log(
    `  ${gate.warranted.metric.padEnd(27)}: ${pct(score.warrantedSuppression)}    budget: ${pct(BUDGET)}` +
      `                ${gate.warranted.pass ? "PASS" : "OVER"}${note}`
  );
  // The aggregate verdict, printed rather than left to be read off the rows —
  // the criteria are asymmetric and "0 good digests lost" is easy to quote as
  // if it were the whole gate.
  console.log(`\n  VERDICT: gate ${gate.pass ? "PASS" : "FAIL"}${STRICT ? "" : "   (--strict exits 1 on FAIL)"}`);
  const supp = records.filter((r) => r.warranted && !r.inject);
  if (supp.length) {
    console.log(`\n-- what the warranted suppressions actually cost (judge's rating of the suppressed digest) --`);
    for (const r of supp) {
      console.log(
        `  ${r.case_id}  ${String(r.project_slug).padEnd(12)} ${String(r.prompt_words).padStart(3)}w  ` +
          `judge: ${String(r.judgeVerdict).padEnd(8)} score ${r.judgeScore}  top slot ${r.topSlot}` +
          (r.good ? "   <-- GOOD DIGEST LOST" : "")
      );
    }
  }
}

async function main() {
  if (!LABELS_DIR) die("--labels <dir> is required (the preserved digest-intent eval corpus — see README.md)");
  const judgeFile = path.join(LABELS_DIR, "out", "judge-actual-vs-current.jsonl");
  const replayFile = path.join(LABELS_DIR, "out", "replay-current.jsonl");
  const casesFile = path.join(LABELS_DIR, "cases", "cases.jsonl");
  for (const f of [judgeFile, replayFile, casesFile]) if (!fs.existsSync(f)) die(`corpus incomplete: no ${f}`);
  const tplFile = TEMPLATE
    ? path.resolve(TEMPLATE)
    : path.join(ENGINE_ROOT, "prompts", "client", "digest-intent.md");
  if (!fs.existsSync(tplFile)) die(TEMPLATE ? `no such template: ${tplFile}` : `no classifier template under ${ENGINE_ROOT}`);

  const judged = readJsonl(judgeFile);
  const replay = Object.fromEntries(readJsonl(replayFile).map((r) => [r.case_id, r]));
  const cases = Object.fromEntries(readJsonl(casesFile).map((c) => [c.case_id, c]));
  const pop = M.selectPopulation({ judged, replay, caseIds: new Set(Object.keys(cases)) });

  const population = pop.fired.length;
  let set = pop.fired;
  if (ONLY) {
    const want = new Set(ONLY.split(",").map((x) => x.trim()).filter(Boolean));
    set = set.filter((r) => want.has(r.case_id));
    const absent = [...want].filter((id) => !set.some((r) => r.case_id === id));
    if (absent.length) die(`--only names ${absent.length} case(s) outside the fired population: ${absent.join(", ")}`);
  }
  if (LIMIT) set = set.slice(0, LIMIT);
  process.stderr.write(`fired user-prompt cases: ${set.length} (skipped ${pop.skipped.length} backend-persona/absent)\n`);
  if (set.length < population) {
    process.stderr.write(
      `NOTE: scoring ${set.length}/${population} of the population — a sub-population CANNOT pass the gate\n`
    );
  }

  const tpl = u.stripTrailingNewlines(fs.readFileSync(tplFile, "utf8"));
  const tplSha = u.sha256Head(tplFile);

  // --replay scores a run recorded earlier (this repo's own history, or the
  // preserved 2026-07-06 runs) without spending a backend call, so a reported
  // number can always be re-derived from its decision record.
  let decisions;
  let graph = null;
  if (REPLAY) {
    const prior = Object.fromEntries(readJsonl(REPLAY).map((r) => [r.case_id, r]));
    // A replay must COVER the population it is scored against. Substituting the
    // fail-open inject for an absent case is the production behaviour, but here
    // it is not a measurement: both harm metrics count suppressions, so a
    // truncated, empty or wrong-corpus file would score zero suppressions and
    // report a PASS (exit 0 under --strict) having classified nothing. A record
    // without a boolean `inject` is missing for the same reason — it carries no
    // decision, and reading its absence as `false` would invent a suppression.
    const missing = set.filter((r) => !prior[r.case_id] || typeof prior[r.case_id].inject !== "boolean");
    if (missing.length) {
      const ids = missing.slice(0, 6).map((r) => r.case_id).join(", ");
      die(
        `replay ${REPLAY} carries decisions for ${set.length - missing.length}/${set.length} selected cases.\n` +
          `  missing ${missing.length}: ${ids}${missing.length > 6 ? ", …" : ""}\n` +
          `  a partial replay is not a run — an unclassified case would score as the fail-open\n` +
          `  inject and read as a PASS. Re-record with --out, or narrow the population (--limit).`
      );
    }
    const extra = Object.keys(prior).length - set.length;
    if (extra > 0) process.stderr.write(`replay covers ${set.length}/${set.length} selected (+${extra} out of population)\n`);
    decisions = set.map((r) => prior[r.case_id]);
  } else {
    graph = fs.mkdtempSync(path.join(os.tmpdir(), "intent-eval-graph-"));
    decisions = await pool(set, CONC, (r) => {
      const c = cases[r.case_id];
      const vars = { SLUG: c.project_slug, PROMPT: c.prompt, DIGEST: replay[r.case_id].candidate_digest };
      return classify({
        prompt: u.fillTemplate(tpl, vars),
        tplSha,
        session: `intent-eval-${r.case_id}`,
        slug: c.project_slug,
        graph,
        timeoutMs: TIMEOUT,
        cmd: CMD,
        vars,
      });
    });
  }

  const records = set.map((r, i) => ({
    case_id: r.case_id,
    project_slug: r.project_slug,
    source: r.source,
    prompt_words: r.prompt_words,
    warranted: r.warranted,
    good: r.warranted && M.isGoodDigest(r),
    // The judge's rating of the digest the classifier was shown (arm b). A
    // suppression is only readable with it: "warranted prompt" is a label on
    // the PROMPT, and suppressing a digest the judge scored 1/noise costs the
    // user nothing, while suppressing a 5/relevant one is the harm the gate
    // exists to catch.
    judgeVerdict: (r.b && r.b.verdict) ?? null,
    judgeScore: (r.b && r.b.score) ?? null,
    topSlot: (r.b && r.b.top_slot) ?? null,
    verdict: decisions[i].verdict,
    inject: decisions[i].inject,
    ms: decisions[i].ms,
    error: decisions[i].error ?? null,
  }));

  const score = M.scoreRun(records);
  const gate = M.gateVerdict(score, BUDGET, { population });
  const byId = Object.fromEntries(records.map((r) => [r.case_id, r]));
  const tables = {
    "current engine": M.fireRow(pop.userPrompt, pop.fires),
    "engine+classifier": M.fireRow(pop.userPrompt, (id) => pop.fires(id) && (byId[id] ? byId[id].inject : true)),
  };
  const spend = graph ? backendSpend(graph) : null;

  report(records, score, gate, tables, spend, {
    judged: pop.labeled.length,
    notFired: pop.notFired,
    skipped: pop.skipped.length,
    tplFile,
    tplSha,
  });

  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`\nwrote ${OUT}`);
  }
  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ label: LABEL, tplSha, score, gate, tables, spend }, null, 2));
    console.log(`wrote ${JSON_OUT}`);
  }
  if (graph) console.log(`llm-calls: ${path.join(graph, "journal", "llm-calls")}`);
  if (STRICT && !gate.pass) process.exit(1);
}

main().catch((e) => die(e.stack || String(e)));
