"use strict";
// Re-judging pass for scripts/rank-eval's pooling mode (issue-spor-digest-
// rank-eval-retrieval-blind): labels every pooled candidate node run.js --pool
// found that neither original judged arm covered, keyed by NODE ID — the
// positional-join fragility documented in labels.js's THE JOIN comment doesn't
// apply here, since the candidate dump already carries ids.
//
// Same rubric as the original digest-intent paired judge (relevant/tangential/
// noise), applied ABSOLUTELY per candidate instead of as a paired A/B
// comparison — pooling asks "is this node worth a slot", not "which of two
// digests is better".
//
//   node scripts/rank-eval/pool-judge.js --candidates <file> [--out <file>]
//        [--cmd <backend>] [--model haiku] [--concurrency N] [--limit N]
//
// Backend contract matches the rest of the plugin's LLM call sites (SPOR_
// NUDGE_CMD / SPOR_DISTILL_CMD, scripts/engines/util.js runClassifierBackend):
// a prompt in, response text out. Default is the same `claude -p --model
// haiku --max-turns 1 --output-format json <prompt>` invocation
// runClaudeBackend uses, so this needs no raw ANTHROPIC_API_KEY, only an
// authenticated `claude` CLI — pass --cmd "<shell command>" (stdin -> stdout)
// for a different backend instead.
//
// Candidates are batched ONE CALL PER CASE (every new id for that case judged
// together against the same prompt+context) to bound spend, not one call per
// candidate — the original judge corpus spent 150 calls on far fewer
// candidates per case than this pass typically sees.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const arg = (name, def) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const CANDIDATES = arg("candidates", null);
const OUT = arg("out", null);
const CMD = arg("cmd", null);
const MODEL = arg("model", "haiku");
const CONC = parseInt(arg("concurrency", "4"), 10);
const LIMIT = parseInt(arg("limit", "0"), 10);
const TIMEOUT_MS = parseInt(arg("timeout", "60000"), 10);

function die(msg) {
  console.error(`pool-judge: ${msg}`);
  process.exit(2);
}

if (!CANDIDATES) die("--candidates <file> is required (run.js --pool output)");
if (!fs.existsSync(CANDIDATES)) die(`no candidates file at ${CANDIDATES}`);
const OUT_FILE = OUT || CANDIDATES.replace(/\.jsonl$/, "") + "-labeled.jsonl";

const RUBRIC = `You judge candidate knowledge-graph nodes for a context "digest" a coding assistant's UserPromptSubmit hook might inject for a user's prompt. For each candidate node, rate whether including it in the digest would be worth the slot:
- "relevant": on-topic AND useful for what the prompt is actually asking / the work it implies.
- "tangential": from the right project/area but not about this specific task.
- "noise": unrelated, generic, or stale ingestion bookkeeping (e.g. "Pending capture", rejected/merged capture shells).
Rate each candidate independently — you are not ranking or comparing them, just judging worth-a-slot in isolation.`;

function fmtCtx(ctx) {
  if (!ctx || !ctx.length) return "(none — first prompt in session)";
  return ctx.map((t) => `  [${t.role}] ${String(t.text || "").replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
}

function buildPrompt(prompt, ctx, items) {
  const nodesText = items
    .map((it, i) => `  ${i + 1}. [${it.node_id}] ${it.title}${it.title ? " — " : ""}${it.summary}`.slice(0, 400))
    .join("\n");
  return `${RUBRIC}\n\nUSER PROMPT:\n${String(prompt).slice(0, 1500)}\n\nPRECEDING CONVERSATION (most recent last):\n${fmtCtx(ctx)}\n\nCANDIDATE NODES:\n${nodesText}\n\nOutput ONLY valid JSON, no prose, mapping EVERY candidate node id above to its rating:\n{"<id>": "relevant"|"tangential"|"noise", ...}`;
}

// Mirrors scripts/engines/util.js's TWO backend shapes — deliberately not
// requiring that module, since this is standalone dev tooling, not part of
// the published hook surface:
//   --cmd <shell>  — runBackendCmd's contract: prompt piped on STDIN, response
//                    read from stdout.
//   default        — runClaudeBackend's contract: prompt is the trailing ARGV
//                    word (`claude -p ... <prompt>`, no stdin at all), json
//                    envelope parsed for `.result`.
//
// ASYNC spawn, not spawnSync: this is called from N concurrent poolConc
// workers, and spawnSync blocks the whole (single-threaded) event loop for
// the child's entire lifetime, silently serializing every "concurrent" call
// behind it — the harness would spend the whole judging pass running one
// claude process at a time regardless of --concurrency.
function callBackend(prompt) {
  return new Promise((resolve) => {
    const [cmd, args, input] = CMD
      ? ["sh", ["-c", CMD], prompt]
      : ["claude", ["-p", "--model", MODEL, "--max-turns", "1", "--output-format", "json", prompt], null];
    const child = spawn(cmd, args, { stdio: [input != null ? "pipe" : "ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      if (CMD) return resolve(out);
      try { resolve(JSON.parse(out).result ?? out); } catch { resolve(out); }
    });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    if (input != null) {
      child.stdin.on("error", () => resolve(null));
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

function parseVerdict(text) {
  try {
    const j = String(text).replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim();
    return JSON.parse(j.slice(j.indexOf("{"), j.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
}

async function poolConc(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function main() {
  const rows = fs.readFileSync(CANDIDATES, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const byCase = new Map();
  for (const r of rows) {
    if (!byCase.has(r.case_id)) byCase.set(r.case_id, { prompt: r.prompt, preceding_context: r.preceding_context, items: [] });
    byCase.get(r.case_id).items.push(r);
  }
  let cases = [...byCase.entries()];
  if (LIMIT) cases = cases.slice(0, LIMIT);
  const backend = CMD ? `cmd:${CMD}` : `cli:claude -p --model ${MODEL}`;
  console.log(`pool-judge: ${rows.length} candidates across ${cases.length} cases; backend=${backend}`);

  const fd = fs.openSync(OUT_FILE, "w");
  let labeled = 0, failedCases = 0, judgedCases = 0;

  await poolConc(cases, CONC, async ([caseId, c]) => {
    const raw = await callBackend(buildPrompt(c.prompt, c.preceding_context, c.items));
    const verdict = raw ? parseVerdict(raw) : null;
    if (!verdict) {
      failedCases++;
      console.error(`  ${caseId}: judge failed/unparseable — dropping ${c.items.length} candidate(s)`);
      return;
    }
    judgedCases++;
    for (const it of c.items) {
      const relevance = verdict[it.node_id];
      if (!["relevant", "tangential", "noise"].includes(relevance)) continue;
      labeled++;
      fs.writeSync(fd, JSON.stringify({ case_id: caseId, node_id: it.node_id, relevance }) + "\n");
    }
  });
  fs.closeSync(fd);

  const manifest = {
    model: backend,
    date: new Date().toISOString().slice(0, 10),
    source_candidates: path.relative(path.join(__dirname, "..", ".."), path.resolve(CANDIDATES)),
    candidates: rows.length,
    cases: cases.length,
    cases_judged: judgedCases,
    cases_failed: failedCases,
    labels_written: labeled,
  };
  fs.writeFileSync(OUT_FILE.replace(/\.jsonl$/, "") + ".provenance.json", JSON.stringify(manifest, null, 2) + "\n");
  console.log(`pool-judge: labeled ${labeled}/${rows.length} candidates (${failedCases}/${cases.length} cases failed) -> ${OUT_FILE}`);
}

main().catch((e) => die(e.stack || String(e)));
