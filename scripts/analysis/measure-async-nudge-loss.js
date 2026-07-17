"use strict";
// measure-async-nudge-loss: quantify the session-final capture-nudge loss that
// the async classifier's one-turn delay causes, so the build-vs-accept fork on
// issue-spor-async-nudge-session-final-loss resolves from data rather than from
// the shape of the code (task-spor-measure-async-nudge-session-final-loss).
//
// WHY THIS IS A COUNTERFACTUAL, NOT A SPOOL SWEEP
// The task's first-cut method was to count undrained
// journal/pending-nudges/<session>/*.out.json spools left behind at session end.
// That method has no denominator: nudge.async is opt-in and DEFAULT OFF
// (dec-cc-async-classifier-opt-in-default-off), so no graph has ever spooled a
// result to count. Waiting for spools to accrue would gate the fork on first
// enabling the mode the fork is about.
//
// The loss condition is structural, though, and it is fully observable in the
// SHIPPED SYNCHRONOUS history. Under async a finding is lost iff its classifier
// result becomes available with no subsequent UserPromptSubmit in that session
// to drain it — drainPendingNudges() runs only at prompt time, keyed by session
// (scripts/engines/prompt-context.js). Both modes run the SAME classifier
// (classifyForNudge) behind the SAME eligibility gates; async only moves the
// call off the tool loop. So replaying the recorded verdicts against real
// session prompt timelines answers exactly what async would have lost.
//
// The two inputs are read-only:
//   <graph home>/journal/llm-calls/*.jsonl  every classifier call — session, ts,
//       file, response. source=nudge is the capture classifier; source=distill*
//       is the SessionEnd distiller, i.e. the backstop this issue leans on.
//   <transcripts>/*/<session>.jsonl         Claude Code transcripts: the prompt
//       timeline oracle. A genuine UserPromptSubmit is a `type: user` entry that
//       is NOT a tool_result echo (those dominate the file ~40:1) and NOT
//       injected meta (skill loads, command expansions). See isPromptEntry().
//
// Verdicts are parsed with the REAL production parser (parseFactList, imported
// from the engine) so the measurement tracks shipped behavior instead of a
// re-implementation that could drift from it.
//
//   node scripts/analysis/measure-async-nudge-loss.js [--home <dir>]
//        [--transcripts <dir>] [--json] [--limit-days <n>]

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { parseFactList } = require("../engines/post-tool.js");

// Hand adjudication of every lost fact against its session's distiller output,
// keyed by sha256(session|fact) so it survives re-runs and re-orderings. The
// lexical score below is only a lower bound — it charges a real capture as a
// miss whenever the distiller restated the fact in its own words, which is most
// of the time — so the headline coverage number comes from this census instead.
// Regenerating it after the classifier corpus grows is a manual pass.
const ADJUDICATION = path.join(__dirname, "adjudication-2026-07-17.json");

// A classifier result is only worth draining when it found ≥1 fact — the async
// worker writes NO result file for a NOTHING verdict or a backend failure
// (scripts/engines/nudge-worker.js), so those can never be "lost".
function verdictFacts(rec) {
  if (rec.error) return null; // backend failed: no result written, nothing to lose
  const response = String(rec.response ?? "");
  if (response.includes("NOTHING")) return { nfacts: 0, facts: "" };
  const facts = parseFactList(response);
  const nfacts = facts.split("\n").filter((l) => /^[0-9]/.test(l)).length;
  return { nfacts, facts };
}

// Is this transcript entry a genuine prompt submission — i.e. would it have
// fired UserPromptSubmit and drained the spool?
//
// Three populations share `type: user` and only the first is a prompt:
//   - a real submission: `promptSource` is set (typed | sdk | system | queued |
//     suggestion_accepted). Older transcripts predate the field, so an untagged
//     plain-text entry counts too.
//   - a tool_result echo fed back into the loop — never a prompt.
//   - injected meta (skill bodies, slash-command expansions) — never a prompt.
// Sidechain (subagent) turns are excluded: a subagent's turn is not a user
// submission and does not fire the parent session's UserPromptSubmit.
//
// `strict` narrows to human-typed prompts only — the pessimistic sensitivity
// bound, since it treats every agent/system-driven turn as a non-drain.
function isPromptEntry(d, strict) {
  if (d.type !== "user" || d.isSidechain) return false;
  const content = (d.message || {}).content;
  if (Array.isArray(content) && content.some((b) => b && b.type === "tool_result")) return false;
  if (strict) return d.promptSource === "typed";
  if (d.promptSource) return true;
  return !d.isMeta && content != null;
}

// session id -> transcript path, across every project dir.
function indexTranscripts(root) {
  const index = new Map();
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return index;
  }
  for (const dir of dirs) {
    const dp = path.join(root, dir.name);
    let files = [];
    try {
      files = fs.readdirSync(dp);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      // A session can be resumed into a second project dir; keep the largest
      // copy so the prompt timeline is the most complete one available.
      const fp = path.join(dp, f);
      const id = f.slice(0, -6);
      const prev = index.get(id);
      if (!prev) index.set(id, fp);
      else {
        try {
          if (fs.statSync(fp).size > fs.statSync(prev).size) index.set(id, fp);
        } catch {}
      }
    }
  }
  return index;
}

// Prompt-submission epochs for one session, ascending. Returns null when the
// transcript is gone (rotated/deleted) — an unknown timeline must never be
// scored as a loss.
function promptTimeline(file, strict) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPromptEntry(d, strict)) continue;
    const t = Date.parse(d.timestamp);
    if (!Number.isNaN(t)) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

function readLlmCalls(home) {
  const dir = path.join(home, "journal", "llm-calls");
  const recs = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return recs;
  }
  for (const f of files) {
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        recs.push(JSON.parse(line));
      } catch {}
    }
  }
  return recs;
}

const STOP = new Set(
  ("the a an and or but of to in for on at by with from is are was were be been it its this that these those as not no " +
    "if then than so into over under out up down we you they i he she them his her their our your my me can will would " +
    "should could may might must do does did done have has had having only just also more most other some such own same " +
    "very s t don now when where which who whom what why how all any both each few nor too there here")
    .split(" ")
);

// Crude suffix stripping so `rejects`/`reject` and `placeholders`/`placeholder`
// match. Without it the two sides of a real capture score as a miss purely on
// inflection — observed on hand-checked pairs where the distiller plainly did
// record the same fact in different words.
function stem(w) {
  return w
    .replace(/(ies)$/, "y")
    .replace(/(sses|shes|ches|xes)$/, "")
    .replace(/(ing|ed|es|s)$/, "");
}

// The token class keeps `.`, `/` and `-` so identifiers survive whole
// (`lib/seed/schema-question.md`, `spor-server`), which also swallows sentence
// punctuation — `placeholders.` would then never match `placeholder`. Trim the
// trailing run before stemming; leaving it in silently deflates every overlap
// score, since the word ending a sentence is usually the salient one.
function contentWords(s) {
  return new Set(
    String(s)
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9._/-]*/g)
      ?.map((w) => w.replace(/[._/-]+$/, ""))
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map(stem) ?? []
  );
}

// The classifier emits a numbered list, so score each fact SEPARATELY: a finding
// of 2 facts where the distiller caught 1 is half-captured, not a clean miss.
// Scoring the joined block (the first cut here) charged the whole finding as
// uncovered and understated the backstop.
function splitFacts(facts) {
  const out = [];
  for (const line of String(facts).split("\n")) {
    const m = line.match(/^[0-9]+[.)]\s*(.+)$/);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

// Approximate coverage: what share of ONE lost fact's content words the
// distiller's extraction for that session reproduces. This is lexical, so it is
// a WEAK LOWER BOUND on real capture, not proof — two texts can state the same
// fact with little vocabulary in common. Reported across several thresholds, and
// always alongside the exact backstop-availability numbers, which need no such
// inference.
function coverage(fact, distillText) {
  const a = contentWords(fact);
  if (!a.size) return 0;
  const b = contentWords(distillText);
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / a.size;
}

const COVERED_AT = 0.6; // ≥60% of a fact's content words present in the distiller's output
const THRESHOLDS = [0.3, 0.4, 0.5, 0.6];

function factKey(session, fact) {
  return crypto.createHash("sha256").update(`${session}|${fact}`).digest("hex").slice(0, 12);
}

// key -> covered?, empty when the census is absent (the exact numbers and the
// lexical bound still print; only the adjudicated line drops out).
function loadAdjudication() {
  try {
    const doc = JSON.parse(fs.readFileSync(ADJUDICATION, "utf8"));
    return new Map((doc.facts || []).map((f) => [f.key, !!f.covered]));
  } catch {
    return new Map();
  }
}

function main(argv) {
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const home = arg("--home", process.env.SPOR_HOME || path.join(os.homedir(), ".spor"));
  const transcripts = arg("--transcripts", path.join(os.homedir(), ".claude", "projects"));
  const asJson = argv.includes("--json");

  const recs = readLlmCalls(home);
  const nudges = recs.filter((r) => r.source === "nudge");
  // The SessionEnd distiller is `distill` locally and `distill-remote` when the
  // transcript is shipped to a server for ingestion; both are the same backstop.
  const distills = recs.filter((r) => String(r.source || "").startsWith("distill"));

  const distillBySession = new Map();
  for (const d of distills) {
    if (!d.session) continue;
    const prev = distillBySession.get(d.session) || [];
    prev.push(d);
    distillBySession.set(d.session, prev);
  }

  const index = indexTranscripts(transcripts);
  // The session running THIS analysis has not ended; its findings are still
  // drainable, so scoring them as losses would be wrong.
  const liveSession = process.env.CLAUDE_SESSION_ID || null;

  const timelines = new Map();
  const timelineFor = (session, strict) => {
    const key = `${session}|${strict ? 1 : 0}`;
    if (!timelines.has(key)) {
      const f = index.get(session);
      timelines.set(key, f ? promptTimeline(f, strict) : null);
    }
    return timelines.get(key);
  };

  const stats = {
    calls: nudges.length,
    errors: 0,
    nothing: 0,
    findings: 0, // calls that found ≥1 fact (a result file would exist under async)
    factsTotal: 0,
    scored: 0,
    lost: 0,
    lostFacts: 0,
    drained: 0,
    noTranscript: 0,
    liveSkipped: 0,
    lostStrict: 0,
    scoredStrict: 0,
    sessions: new Set(),
    lostSessions: new Set(),
  };
  const lostRecords = [];

  for (const r of nudges) {
    const v = verdictFacts(r);
    if (v === null) {
      stats.errors++;
      continue;
    }
    if (v.nfacts < 1) {
      stats.nothing++;
      continue;
    }
    stats.findings++;
    stats.factsTotal += v.nfacts;
    if (!r.session) {
      stats.noTranscript++;
      continue;
    }
    stats.sessions.add(r.session);
    if (liveSession && r.session === liveSession) {
      stats.liveSkipped++;
      continue;
    }
    const tl = timelineFor(r.session, false);
    if (tl === null) {
      // No transcript => the timeline is unknowable. Counted separately and
      // excluded from the rate rather than guessed either way.
      stats.noTranscript++;
      continue;
    }
    const at = Date.parse(r.ts); // recorded AFTER the backend returns, so this is
    // when the worker's result file would exist — the earliest drainable moment.
    if (Number.isNaN(at)) {
      stats.noTranscript++;
      continue;
    }
    stats.scored++;
    const drained = tl.some((t) => t > at);
    if (drained) stats.drained++;
    else {
      stats.lost++;
      stats.lostFacts += v.nfacts;
      stats.lostSessions.add(r.session);
      lostRecords.push({ session: r.session, ts: r.ts, project: r.project, file: (r.vars || {}).FILE, facts: v.facts, nfacts: v.nfacts });
    }

    const tls = timelineFor(r.session, true);
    if (tls !== null) {
      stats.scoredStrict++;
      if (!tls.some((t) => t > at)) stats.lostStrict++;
    }
  }

  // Backstop: for each lost finding, did the SessionEnd distiller run for that
  // session, did it extract anything, and does what it extracted look like the
  // same fact? The first two are exact; the third is the lexical lower bound.
  let backstopRan = 0;
  let backstopFacts = 0;
  const coverageSamples = [];
  const coveredAt = Object.fromEntries(THRESHOLDS.map((t) => [t, 0]));
  let lostFactsScored = 0; // individual facts whose session had a productive distill
  for (const L of lostRecords) {
    const ds = distillBySession.get(L.session) || [];
    if (!ds.length) continue;
    backstopRan++;
    const text = ds.map((d) => String(d.response ?? "")).join("\n");
    const productive = ds.some(
      (d) => !d.error && !String(d.response ?? "").includes("NOTHING") && String(d.response ?? "").trim()
    );
    if (!productive) continue;
    backstopFacts++;
    for (const fact of splitFacts(L.facts)) {
      lostFactsScored++;
      const c = coverage(fact, text);
      coverageSamples.push({
        key: factKey(L.session, fact),
        session: L.session,
        file: L.file,
        fact,
        cov: Number(c.toFixed(3)),
      });
      for (const t of THRESHOLDS) if (c >= t) coveredAt[t]++;
    }
  }
  const covered = coveredAt[COVERED_AT];

  // Join the census. Facts with no adjudication are reported, not assumed
  // either way — a stale census must never silently shrink the loss.
  const verdicts = loadAdjudication();
  let adjCovered = 0;
  let adjLost = 0;
  let adjMissing = 0;
  for (const s of coverageSamples) {
    const v = verdicts.get(s.key);
    if (v === undefined) adjMissing++;
    else if (v) adjCovered++;
    else adjLost++;
  }
  // Facts the distiller never had a chance at: its session produced no
  // extraction at all, so nothing could have covered them.
  const noBackstopFacts = stats.lostFacts - lostFactsScored;
  const durablyLost = adjMissing ? null : adjLost + noBackstopFacts;

  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");
  const out = {
    home,
    transcripts,
    calls: stats.calls,
    errors: stats.errors,
    nothing: stats.nothing,
    findings: stats.findings,
    factsTotal: stats.factsTotal,
    scored: stats.scored,
    drained: stats.drained,
    lost: stats.lost,
    lostFacts: stats.lostFacts,
    lossRate: stats.scored ? stats.lost / stats.scored : null,
    lossRateStrict: stats.scoredStrict ? stats.lostStrict / stats.scoredStrict : null,
    scoredStrict: stats.scoredStrict,
    lostStrict: stats.lostStrict,
    noTranscript: stats.noTranscript,
    liveSkipped: stats.liveSkipped,
    sessionsWithFindings: stats.sessions.size,
    sessionsWithLoss: stats.lostSessions.size,
    backstopRan,
    backstopFacts,
    backstopCovered: covered,
    coverageThreshold: COVERED_AT,
    lostFactsScored,
    coveredAt,
  };

  if (asJson) {
    console.log(JSON.stringify({ ...out, lostRecords, coverageSamples }, null, 2));
    return;
  }

  console.log(`# Async capture-nudge session-final loss — counterfactual replay`);
  console.log(`  graph home:  ${home}`);
  console.log(`  transcripts: ${transcripts}`);
  console.log();
  console.log(`## Classifier calls (source=nudge)`);
  console.log(`  total calls .................. ${stats.calls}`);
  console.log(`  backend errors (no result) ... ${stats.errors}`);
  console.log(`  NOTHING verdicts (no result) . ${stats.nothing}`);
  console.log(`  FINDINGS (≥1 fact) ........... ${stats.findings}   [${stats.factsTotal} facts, ${stats.sessions.size} sessions]`);
  console.log();
  console.log(`## Would the async drain have injected it?`);
  console.log(`  scored (transcript found) .... ${stats.scored}`);
  console.log(`  drained (a later prompt) ..... ${stats.drained}  ${pct(stats.drained, stats.scored)}`);
  console.log(`  LOST (no later prompt) ....... ${stats.lost}  ${pct(stats.lost, stats.scored)}   [${stats.lostFacts} facts, ${stats.lostSessions.size} sessions]`);
  console.log(`  unknown (no transcript) ...... ${stats.noTranscript}  (excluded from the rate)`);
  console.log(`  live session skipped ......... ${stats.liveSkipped}`);
  console.log();
  console.log(`  sensitivity — human-typed prompts only (pessimistic bound):`);
  console.log(`    scored ${stats.scoredStrict}, lost ${stats.lostStrict}  ${pct(stats.lostStrict, stats.scoredStrict)}`);
  console.log();
  console.log(`## Does the SessionEnd distiller back it up?`);
  console.log(`  lost findings ................ ${stats.lost}   [${stats.lostFacts} facts]`);
  console.log(`  distiller ran for session .... ${backstopRan}  ${pct(backstopRan, stats.lost)}`);
  console.log(`  distiller extracted facts .... ${backstopFacts}  ${pct(backstopFacts, stats.lost)}`);
  console.log();
  console.log(`  per-fact lexical overlap vs that session's distiller output`);
  console.log(`  (${lostFactsScored} facts from sessions where the distiller DID extract something;`);
  console.log(`   a weak LOWER bound — same fact, different words, scores as a miss):`);
  for (const t of THRESHOLDS) {
    console.log(`    ≥${(t * 100).toFixed(0)}% of content words present ... ${coveredAt[t]}  ${pct(coveredAt[t], lostFactsScored)}`);
  }
  console.log();
  if (adjMissing) {
    console.log(`  hand adjudication: ${adjMissing}/${coverageSamples.length} facts unadjudicated — census is stale,`);
    console.log(`  regenerate it before quoting a coverage number.`);
  } else if (coverageSamples.length) {
    console.log(`  hand adjudication of the same ${lostFactsScored} facts (the number to quote):`);
    console.log(`    distiller DID capture the fact ... ${adjCovered}  ${pct(adjCovered, lostFactsScored)}`);
    console.log(`    distiller MISSED it ............. ${adjLost}  ${pct(adjLost, lostFactsScored)}`);
  }
  console.log();
  console.log(`## Bottom line — facts durably lost (no channel captured them)`);
  console.log(`  facts in lost findings ....... ${stats.lostFacts}`);
  console.log(`  no distiller extraction ...... ${noBackstopFacts}  (nothing could cover these)`);
  console.log(`  distiller missed the fact .... ${adjMissing ? "?" : adjLost}`);
  if (durablyLost !== null) {
    console.log(`  DURABLY LOST ................. ${durablyLost}  ${pct(durablyLost, stats.lostFacts)} of lost facts`);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { verdictFacts, isPromptEntry, coverage, promptTimeline, splitFacts, stem };
