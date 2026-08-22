"use strict";
// Ranking eval for the UserPromptSubmit digest — scores the compiler's node
// ORDERING against the judge's per-node relevance labels
// (task-spor-improve-digest-ranking-relevance).
//
// This is the sibling of the fire-gate eval (art-spor-digest-noise-eval-
// 2026-06-25), which asked "should a digest fire at all". That question is
// semantic and cannot be answered on the prompt path (dec-spor-digest-noise-
// needs-async-semantic-intent). This one asks the narrower question the
// deterministic ranker CAN answer: given that a digest fires, are its best
// nodes at the top?
//
//   node scripts/rank-eval/run.js --labels <evalDir> [--engine-root DIR]
//        [--graph REPO] [--label NAME] [--json OUT] [--limit N]
//
// Method. Same replay trick as the fire-gate harness: the digest is a pure
// function of (prompt, graph@T), and the graph repo commits per node, so each
// case is re-run against the exact snapshot it was labeled at (`snap_sha`, taken
// from the replay record rather than re-resolved, so the engine sees the graph
// the judge's labels describe). The REAL hook binary is driven in forced local
// mode, so the shipped gates + compile + microDigest all apply — a candidate
// engine is A/B'd by pointing --engine-root at it.
//
// Scoring is nDCG@5 and precision@3 over the labeled pool (see metrics.js).
// Nodes the engine emits that carry no label cannot be scored; the report prints
// that coverage rate, because a change that swaps labeled nodes for unlabeled
// ones would otherwise look free.
//
// INODE SAFETY (inherited from the fire-gate harness, and load-bearing): a
// snapshot is ~3.2k loose files and this box has ~1.5M free inodes. Snapshots
// are materialized in bounded batches and rm -rf'd after each batch — never
// cache-all, which re-triggers the ENOSPC incident.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { buildPool, microIds, mergePooledLabels } = require("./labels");
const { ndcgAt, precisionAt, mean } = require("./metrics");
const kernel = require(path.join(__dirname, "..", "..", "lib", "kernel", "graph.js"));

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const flag = (name) => process.argv.includes("--" + name);

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LABELS_DIR = arg("labels", process.env.SPOR_RANK_EVAL_LABELS);
const GRAPH_REPO = arg("graph", process.env.SPOR_RANK_EVAL_GRAPH || path.join(os.homedir(), "repos", "bcdr-substrate"));
const ENGINE_ROOT = path.resolve(arg("engine-root", REPO_ROOT));
const LABEL = arg("label", "current");
const JSON_OUT = arg("json", null);
const LIMIT = parseInt(arg("limit", "0"), 10);
const BATCH = parseInt(arg("batch", "16"), 10);
const CONC = parseInt(arg("concurrency", "8"), 10);

// Retrieval-pooling mode (issue-spor-digest-rank-eval-retrieval-blind): the
// arms-only label pool is blind to a genuinely better node neither judged arm
// ever surfaced (a `labels[id] == null` node is filtered out of ndcgAt's gain
// sum, so it scores neutral rather than being rewarded). --pool runs the
// shipped engine PLUS deliberately-different retrieval variants (below)
// against every case and dumps every candidate id no original label covers to
// --pool-out for a re-judging pass (pool-judge.js) — see README.md.
const POOL = flag("pool");
const POOL_OUT = arg("pool-out", path.join(REPO_ROOT, "scripts", "rank-eval", "pooled-labels", "candidates.jsonl"));
// A previously re-judged pooled-labels file (pool-judge.js output): merged
// into each case's label pool before scoring, so a plain (non-pooling) run
// can report the baseline against the pooled ideal.
const POOLED_LABELS = arg("pooled-labels", null);

// Each variant tweaks ONE retrieval lever via the CAND_* env passthrough
// already wired into runHook (below) — no kernel change beyond the three opts
// levers graph.js's compile()/structuralWalk() now accept (byte-identical
// when unset: opts.contentTopK, opts.querySeeds, opts.maxHops). The microDigest
// window is only 5 nodes and structural hits usually fill it, so a content-arm
// tweak alone rarely changes what's IN the top 5 (README "no lever beat the
// baseline") — the walk-shape levers are what actually swap which nodes
// compete for those slots:
//   content-widened  — more lexical-similarity picks (CONTENT_TOP_K 4 -> 8).
//   structural-only  — content arm off entirely (CONTENT_TOP_K -> 0); an
//     approximation, since the seeds themselves are still top content hits
//     (compile() has no seedless mode).
//   wider-walk       — more seed nodes + one more hop (QUERY_SEEDS 3 -> 6,
//     MAX_HOPS 3 -> 4): a genuinely different structural candidate SET, not
//     just a re-ranking of the same one.
//   narrow-walk      — fewer seeds, shallower walk (QUERY_SEEDS -> 1, MAX_HOPS
//     -> 1): thins the structural set enough that lower-ranked structural/
//     content nodes the shipped walk's cap crowded out can reach the top 5.
const POOL_VARIANTS = {
  "content-widened": { CAND_CONTENT_TOP_K: "8" },
  "structural-only": { CAND_CONTENT_TOP_K: "0" },
  "wider-walk": { CAND_QUERY_SEEDS: "6", CAND_MAX_HOPS: "4" },
  "narrow-walk": { CAND_QUERY_SEEDS: "1", CAND_MAX_HOPS: "1" },
};

const NDCG_K = 5; // the digest renders at most MICRO_MAX_NODES = 5 nodes
const P_K = 3;

function die(msg) {
  console.error(`rank-eval: ${msg}`);
  process.exit(2);
}

// Materialize a snapshot's nodes/ via `git archive` (no checkout, no index).
function materialize(sha, root) {
  const dir = path.join(root, sha);
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync("bash", ["-c", `git -C '${GRAPH_REPO}' archive ${sha} nodes | tar -x -C '${dir}'`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git archive ${sha} failed: ${r.stderr}`);
  return dir;
}

// Best-effort node content (title/summary/type) for a candidate dump, read
// straight from the materialized snapshot the case was labeled at — the same
// text the judge will be shown. Returns null rather than throwing: a rename or
// non-`<id>.md` filename just drops that one candidate from the dump instead
// of failing the whole pooling pass.
function readNodeContent(snapDir, id) {
  try {
    const raw = fs.readFileSync(path.join(snapDir, "nodes", `${id}.md`), "utf8");
    const n = kernel.parseFrontmatter(raw, `${id}.md`);
    return { title: n.title || "", summary: n.summary || "", type: n.type || "" };
  } catch {
    return null;
  }
}

// Load a pool-judge.js output file: JSONL of {case_id, node_id, relevance}.
// Malformed lines are skipped (best-effort; pool-judge.js is the only writer).
function loadPooledLabels(file) {
  const byCase = new Map();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r.case_id || !r.node_id || !r.relevance) continue;
    if (!byCase.has(r.case_id)) byCase.set(r.case_id, {});
    byCase.get(r.case_id)[r.node_id] = r.relevance;
  }
  return byCase;
}

// Drive the real hook in forced LOCAL mode against a snapshot. HOME is a scratch
// dir and the env is curated (not inherited) so a configured dev box's
// SPOR_SERVER/SPOR_TOKEN can't put the hook in REMOTE mode against the live team
// graph (norm-cc-scratch-home-for-tests). The synthetic cwd makes the project
// slug resolve deterministically without touching a real checkout.
function runHook(snapDir, home, c, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: home, SPOR_HOME: snapDir, SPOR_ENABLED: "1" };
    for (const k of Object.keys(process.env)) if (k.startsWith("CAND_")) env[k] = process.env[k];
    Object.assign(env, extraEnv); // variant overrides win over any host CAND_* already set
    const child = spawn(path.join(ENGINE_ROOT, "bin", "spor-hook"), ["prompt-context"], {
      env, stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => {
      let digest = null;
      try { digest = JSON.parse(out.trim()).hookSpecificOutput.additionalContext; } catch { /* no digest / suppressed */ }
      resolve(digest);
    });
    child.on("error", () => resolve(null));
    // A child that died before reading stdin makes this write EPIPE, and an
    // unhandled stream 'error' is fatal — `child.on("error")` only covers spawn
    // itself. A dead engine must score as "no digest", not take down the run.
    child.stdin.on("error", () => resolve(null));
    child.stdin.write(JSON.stringify({ cwd: `/eval/${c.project_slug || "x"}`, prompt: c.prompt, session_id: c.case_id }));
    child.stdin.end();
  });
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

function scoreCase(c, order) {
  const labeled = order.filter((id) => c.labels[id] != null);
  return {
    case_id: c.case_id,
    project_slug: c.project_slug,
    warranted: c.warranted,
    fired: order.length > 0,
    order,
    ndcg: ndcgAt(order, c.labels, NDCG_K),
    precision: precisionAt(order, c.labels, P_K),
    emitted: order.length,
    labeledEmitted: labeled.length,
    // Did the ranker reproduce the order it had at label time? Pure diagnostic:
    // labels join by ID, so drift doesn't invalidate scoring, it just explains
    // it. null when arm B has no order to compare against (excluded from the
    // rate rather than counted as a miss).
    reproducedBaseline: c.baselineOrder ? order.join(",") === c.baselineOrder.join(",") : null,
  };
}

function report(results, stats, poolCases) {
  const fired = results.filter((r) => r.fired);
  const ndcgs = results.map((r) => r.ndcg).filter((x) => x != null);
  const precs = results.map((r) => r.precision).filter((x) => x != null);
  const emitted = fired.reduce((a, r) => a + r.emitted, 0);
  const labeledEmitted = fired.reduce((a, r) => a + r.labeledEmitted, 0);
  const comparable = fired.filter((r) => r.reproducedBaseline != null);
  const reproduced = comparable.filter((r) => r.reproducedBaseline).length;
  const overlap = stats.agree + stats.conflict;

  // A rate with no denominator reads "n/a", never "NaN%" — an empty run (say
  // --limit 1 onto a case that fires nothing) still prints a usable report.
  const pct = (x) => (x == null || !Number.isFinite(x) ? "n/a" : (x * 100).toFixed(1) + "%");
  const ratio = (num, den) => (den > 0 ? num / den : null);
  const n4 = (x) => (x == null ? "n/a" : x.toFixed(4));

  console.log(`\n=== rank-eval: ${LABEL} ===`);
  console.log(`engine       : ${ENGINE_ROOT}`);
  console.log(`labeled set  : ${poolCases.length} cases (${stats.judged} judged; ` +
    `-${stats.noPrompt} prompt lost to re-extraction, -${stats.misaligned} label/line misaligned, ` +
    `-${stats.noLabels} no digest either arm, -${stats.noReplay} no replay)`);
  console.log(`label join   : ${stats.agree}/${overlap} arm-overlap agreement ` +
    `(${pct(ratio(stats.agree, overlap))}) — judge consistency + join sanity check`);
  console.log(`scored       : nDCG@${NDCG_K} over ${ndcgs.length} cases, P@${P_K} over ${precs.length} cases`);
  console.log(`--`);
  console.log(`nDCG@${NDCG_K}      : ${n4(mean(ndcgs))}`);
  console.log(`P@${P_K}         : ${n4(mean(precs))}`);
  console.log(`--`);
  console.log(`fired        : ${fired.length}/${results.length}`);
  console.log(`label cover  : ${labeledEmitted}/${emitted} emitted nodes carry a label (${pct(ratio(labeledEmitted, emitted))})`);
  console.log(`baseline repro: ${reproduced}/${comparable.length} cases emit the label-time order (${pct(ratio(reproduced, comparable.length))})`);

  const warranted = results.filter((r) => r.warranted);
  const wn = warranted.map((r) => r.ndcg).filter((x) => x != null);
  if (wn.length) console.log(`nDCG@${NDCG_K} (warranted-only, n=${wn.length}): ${n4(mean(wn))}`);
  return { label: LABEL, ndcg: mean(ndcgs), precision: mean(precs), ndcgWarranted: mean(wn), n: ndcgs.length, stats };
}

async function main() {
  if (!LABELS_DIR) die("--labels <dir> is required (the preserved digest-intent eval corpus)");
  if (!fs.existsSync(path.join(LABELS_DIR, "out", "judge-actual-vs-current.jsonl"))) die(`no judge output under ${LABELS_DIR}`);
  if (!fs.existsSync(path.join(GRAPH_REPO, ".git"))) die(`graph repo not found at ${GRAPH_REPO}`);
  if (!fs.existsSync(path.join(ENGINE_ROOT, "bin", "spor-hook"))) die(`no hook binary under ${ENGINE_ROOT}`);

  const { cases: rawCases, stats } = buildPool(LABELS_DIR);
  // Merge a prior pooled re-judging pass BEFORE scoring, so a plain re-report
  // run (no --pool) scores against the pooled ideal (README "re-reported
  // baseline"); a --pool run also merges it so already-pooled ids aren't
  // re-dumped as "new" candidates on a second pooling pass.
  const cases = POOLED_LABELS ? mergePooledLabels(rawCases, loadPooledLabels(POOLED_LABELS)) : rawCases;
  const set = LIMIT ? cases.slice(0, LIMIT) : cases;

  if (POOL) fs.mkdirSync(path.dirname(POOL_OUT), { recursive: true });
  const poolFd = POOL ? fs.openSync(POOL_OUT, "w") : null;
  let poolCandidates = 0;
  let poolCasesTouched = 0;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rank-eval-home-"));
  const snapRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rank-eval-snaps-"));
  const bySha = new Map();
  for (const c of set) {
    if (!c.snap_sha) continue;
    if (!bySha.has(c.snap_sha)) bySha.set(c.snap_sha, []);
    bySha.get(c.snap_sha).push(c);
  }
  const shas = [...bySha.keys()];
  console.log(`rank-eval: ${set.length} labeled cases across ${shas.length} snapshots; engine=${ENGINE_ROOT}`);

  const results = [];
  try {
    for (let b = 0; b < shas.length; b += BATCH) {
      const batch = shas.slice(b, b + BATCH);
      for (const sha of batch) materialize(sha, snapRoot);
      const work = batch.flatMap((sha) => bySha.get(sha).map((c) => [sha, c]));
      await pool(work, CONC, async ([sha, c]) => {
        const snapDir = path.join(snapRoot, sha);
        const digest = await runHook(snapDir, home, c);
        const order = microIds(digest);
        results.push(scoreCase(c, order));

        if (!POOL) return;
        // Pooling: union the shipped order with every variant's order, then
        // keep only ids no label (original arms + any already-pooled labels)
        // covers. One judge-worthy candidate record per NEW (case, node) pair,
        // carrying which retriever(s) surfaced it (provenance, not scoring).
        const surfacedBy = new Map(); // id -> [variant names]
        const add = (ids, name) => { for (const id of ids) if (c.labels[id] == null) {
          if (!surfacedBy.has(id)) surfacedBy.set(id, []);
          surfacedBy.get(id).push(name);
        } };
        add(order, "shipped");
        for (const [variantName, extraEnv] of Object.entries(POOL_VARIANTS)) {
          const vDigest = await runHook(snapDir, home, c, extraEnv);
          add(microIds(vDigest), variantName);
        }
        if (!surfacedBy.size) return;
        poolCasesTouched++;
        for (const [id, sources] of surfacedBy) {
          const content = readNodeContent(snapDir, id);
          if (!content) continue; // renamed/missing file — can't judge without content
          poolCandidates++;
          fs.writeSync(poolFd, JSON.stringify({
            case_id: c.case_id, node_id: id, project_slug: c.project_slug, surfaced_by: sources,
            prompt: c.prompt, preceding_context: c.preceding_context ?? [], ...content,
          }) + "\n");
        }
      });
      for (const sha of batch) fs.rmSync(path.join(snapRoot, sha), { recursive: true, force: true });
      process.stderr.write(`  batch ${Math.floor(b / BATCH) + 1}/${Math.ceil(shas.length / BATCH)} (${results.length}/${set.length})\n`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(snapRoot, { recursive: true, force: true });
  }

  if (poolFd != null) fs.closeSync(poolFd);
  if (POOL) {
    console.log(`\npool: ${poolCandidates} new (case, node) candidates across ${poolCasesTouched} cases ` +
      `need judging -> ${POOL_OUT}`);
    console.log(`pool: variants = shipped, ${Object.keys(POOL_VARIANTS).join(", ")}`);
    console.log(`pool: run pool-judge.js --candidates ${POOL_OUT} to label them, then re-run with --pooled-labels`);
  }

  results.sort((a, b) => a.case_id.localeCompare(b.case_id));
  const summary = report(results, stats, set);
  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ summary, results }, null, 2));
    console.log(`\nwrote ${JSON_OUT}`);
  }
}

main().catch((e) => die(e.stack || String(e)));
