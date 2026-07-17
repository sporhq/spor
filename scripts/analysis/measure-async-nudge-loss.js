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
// result to count — zero sessions on this box carry even a phase-1 `pending`
// reservation. Waiting for spools to accrue would gate the fork on first
// enabling the mode the fork is about.
//
// The loss condition is structural, though, and it is fully observable in the
// SHIPPED SYNCHRONOUS history. Under async a finding is lost iff its classifier
// result becomes available with no subsequent UserPromptSubmit in that session
// to drain it — drainPendingNudges() runs only at prompt time, keyed by session,
// and is NOT behind the digest's trivial-prompt gate (prompt-context.js:498-503),
// so ANY prompt submission drains. Both modes run the same classifier
// (classifyForNudge) behind the same eligibility gates, so replaying the
// recorded verdicts against real session prompt timelines answers what async
// would have lost.
//
// The two inputs are read-only:
//   <graph home>/journal/llm-calls/*.jsonl  every classifier call — session, ts,
//       file, response. source=nudge is the capture classifier; source=distill*
//       is the SessionEnd distiller, i.e. the backstop this issue leans on.
//   <transcripts>/*/<session>.jsonl         Claude Code transcripts: the prompt
//       timeline oracle. See isPromptEntry() for what counts and why.
//
// KNOWN FLOOR (do not quote the counts as totals). The synchronous path stops
// classifying after 3 FIRED nudges in a session (post-tool.js:135-138: sync
// counts fired findings immediately, async approximates via injected+spooled).
// The 4th+ prose write of a session was therefore never classified and cannot
// appear here — and a session-final burst of doc writes is exactly the
// population this measures. The absolute counts are a lower bound; the RATE is
// over what was actually classified.
//
// KNOWN DRIFT. `--until` pins the journal side, but the transcript side lives in
// ~/.claude/projects, which Claude Code prunes on its own retention schedule.
// An evicted transcript moves its finding from `scored` into the reported
// `transcript missing` bucket, so the rate can drift with no flag and the same
// cutoff — already 41 of 117 findings here. It is reported rather than hidden;
// pinning it too would mean committing the derived per-session prompt timelines.
//
//   node scripts/analysis/measure-async-nudge-loss.js [--home <dir>]
//        [--transcripts <dir>] [--until <iso>] [--live-window-min <n>] [--json]

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
// It also pins the corpus: its `until` is the default cutoff, so a plain re-run
// reproduces the committed numbers even though the live journal keeps growing.
const ADJUDICATION = path.join(__dirname, "adjudication-2026-07-17.json");

// A session whose transcript went quiet less than this before the cutoff may
// still be running, and a still-open session's finding is not lost — its next
// prompt simply hasn't happened yet. Those are excluded, not scored.
const DEFAULT_LIVE_WINDOW_MIN = 60;

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

// Harness ECHOES that arrive as `type: user` text but are not submissions: the
// output of a local `/`-command or a `!`-bash run, replayed into the transcript
// with no isMeta flag, so shape is the only thing separating them from a real
// prompt. Each one admitted is a phantom drain that hides a real loss.
//
// `<command-name>` is deliberately NOT here: typing `/clear` or `/spor:defer`
// IS a submission and DOES drain the spool — drainPendingNudges runs before
// computeDigest's `prompt.startsWith("/")` gate (prompt-context.js:503-551), so
// the digest skips a slash command but the nudge drain does not. Excluding it
// would score up to 128 genuine drains as losses and inflate the headline. Note
// the prompt-context stamp cannot referee this: a slash command never produces
// a digest, so it never writes a stamp — the oracle proves accepted entries
// fire the hook, never that excluded ones don't.
const HARNESS_ECHO = /^\s*<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|bash-input)>/;

// Is this transcript entry a genuine prompt submission — i.e. would it have
// fired UserPromptSubmit and drained the spool?
//
// Three populations share `type: user` and only the first is a prompt:
//   - a real submission: `promptSource` is set (typed | sdk | system | queued |
//     suggestion_accepted). Older transcripts predate the field, so an untagged
//     plain-text entry counts too — including a `<command-name>` slash-command
//     submission, minus the HARNESS_ECHO output replays above.
//   - a tool_result echo fed back into the loop — never a prompt, and it
//     outnumbers real prompts ~40:1.
//   - injected meta (skill bodies) — never a prompt.
// Sidechain (subagent) turns are excluded: a subagent's turn does not fire the
// parent session's UserPromptSubmit.
//
// VERIFIED against a UserPromptSubmit-only side effect, not assumed: the
// prompt-context engine stamps journal/prompt-context-<sha256(session)>.json
// with `at` every time it computes a digest. Across the 274 sessions carrying
// both a stamp and a transcript, all 274 stamps land within 3s of an entry this
// predicate accepts, and in 86 of them the ONLY coincident entry is
// `promptSource: system` — so system-injected turns (and by the same token sdk
// turns) do fire the hook. That is why `strict` is a sensitivity bound, not the
// headline: it answers a different question (would a HUMAN have prompted again).
function isPromptEntry(d, strict) {
  if (d.type !== "user" || d.isSidechain) return false;
  let content = (d.message || {}).content;
  if (Array.isArray(content)) {
    if (content.some((b) => b && b.type === "tool_result")) return false;
    content = content
      .filter((b) => b && b.type === "text")
      .map((b) => b.text || "")
      .join("");
  }
  // A tagged submission is a submission whatever its content shape — an
  // image-only paste still fires the hook and drains. Only the untagged path
  // needs the shape heuristics below.
  if (strict) return d.promptSource === "typed";
  if (d.promptSource) return true;
  if (typeof content !== "string" || content === "") return false;
  return !d.isMeta && !HARNESS_ECHO.test(content);
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
      // A session resumed into a second project dir appears twice; keep the
      // largest copy so the prompt timeline is the most complete one available.
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

// One session's timeline AS OF `until`: prompt-submission epochs (ascending)
// and the last entry of ANY kind, which is how we tell an ended session from a
// live one. Returns null when the transcript is gone — an unknown timeline must
// never be scored as a loss.
//
// Everything here is clamped to the cutoff, including lastActivity. An unclamped
// lastActivity reads post-cutoff growth, so `claude --resume` on a session that
// demonstrably ended months ago would reclassify it as "still active at the
// cutoff" and silently drop an already-scored finding — the committed numbers
// would stop reproducing, which is exactly what the pin exists to prevent.
function sessionTimeline(file, strict, until = Infinity) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const prompts = [];
  let lastActivity = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const t = Date.parse(d.timestamp);
    if (Number.isNaN(t) || t > until) continue;
    if (t > lastActivity) lastActivity = t;
    if (isPromptEntry(d, strict)) prompts.push(t);
  }
  prompts.sort((a, b) => a - b);
  return { prompts, lastActivity };
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

// Crude suffix stripping so `rejects`/`reject` and `cases`/`case` match.
// Without it the two sides of a real capture score as a miss purely on
// inflection, and this codebase's core vocabulary (case, cache, response,
// parse, index, class) is exactly what inflects.
//
// ORDER IS THE WHOLE TRICK, and getting it wrong is silent. Strip the plural
// `s` FIRST, then the trailing `e`; both members of a pair then converge on the
// same stem (cases -> case -> cas <- case). An -es rule that runs before the
// plural strip double-fires instead — `cases` -> `cas` -> `ca` while `case` ->
// `cas` — which is the very miss this function exists to prevent, so the test
// table must include an -se word (case/use/response), not only the -ches/-shes
// words that survive either ordering.
function stem(w) {
  return w
    .replace(/ies$/, "y")
    .replace(/sses$/, "ss") // class(es): keep the double-s, don't strip to `clas`
    .replace(/([^s])s$/, "$1") // plural: cases -> case, rejects -> reject
    .replace(/(ing|ed)$/, "")
    .replace(/e$/, ""); // case -> cas <- cases
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
function splitFacts(facts) {
  const out = [];
  for (const line of String(facts).split("\n")) {
    const m = line.match(/^[0-9]+[.)]\s*(.+)$/);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

// Approximate coverage: what share of ONE lost fact's content words the
// distiller's extraction for that session reproduces. Lexical, so it is a WEAK
// LOWER BOUND on real capture, not proof — two texts can state the same fact
// with little vocabulary in common. Reported across several thresholds, and
// always alongside the exact backstop numbers, which need no such inference.
function coverage(fact, distill) {
  const a = contentWords(fact);
  if (!a.size) return 0;
  const b = distill instanceof Set ? distill : contentWords(distill);
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / a.size;
}

const COVERED_AT = 0.6;
const THRESHOLDS = [0.3, 0.4, 0.5, 0.6];

function factKey(session, fact) {
  return crypto.createHash("sha256").update(`${session}|${fact}`).digest("hex").slice(0, 12);
}

// The census is the join key for the headline coverage number, so a malformed
// one must fail loudly: an absent file is fine (the exact numbers and the
// lexical bound still print), but a parse error that silently returned an empty
// map would read as "census stale, re-adjudicate 40 facts by hand".
function loadAdjudication() {
  let raw;
  try {
    raw = fs.readFileSync(ADJUDICATION, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { verdicts: new Map(), until: null };
    throw e;
  }
  const doc = JSON.parse(raw); // deliberately unguarded — a typo must not read as staleness
  return {
    verdicts: new Map((doc.facts || []).map((f) => [f.key, !!f.covered])),
    until: doc.until || null,
  };
}

const FLAGS = ["--home", "--transcripts", "--until", "--live-window-min"];

function main(argv) {
  // Parse argv ONCE into a map. Two different models of the same argv — a
  // validating pre-pass that consumes each flag's value, plus an arg() that
  // re-scans with indexOf — disagree on `--home --json`: the pre-pass lets
  // --home eat --json, arg() then returns "--json" as the graph home, and the
  // run reports an empty corpus at exit 0. Silently ignoring a misspelled flag
  // is how a full-corpus number gets quoted as a windowed one; a silently empty
  // corpus is the same failure wearing a different hat.
  const parsed = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      console.error(`unexpected argument: ${a}`);
      process.exit(2);
    }
    if (a === "--json") {
      parsed.set(a, true);
      continue;
    }
    if (!FLAGS.includes(a)) {
      console.error(`unknown flag: ${a}\nusage: [${FLAGS.join(" <v>] [")} <v>] [--json]`);
      process.exit(2);
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      console.error(`${a}: expected a value`);
      process.exit(2);
    }
    parsed.set(a, v);
    i++;
  }
  const arg = (name, dflt) => (parsed.has(name) ? parsed.get(name) : dflt);
  const home = arg("--home", process.env.SPOR_HOME || path.join(os.homedir(), ".spor"));
  const transcripts = arg("--transcripts", path.join(os.homedir(), ".claude", "projects"));
  const asJson = parsed.has("--json");
  const census = loadAdjudication();
  // Pin the corpus to the census's cutoff by default: the journal grows every
  // session, so an unpinned run re-stales the census within hours and the
  // headline stops being reproducible.
  const untilRaw = arg("--until", census.until);
  const until = untilRaw ? Date.parse(untilRaw) : Date.now();
  if (Number.isNaN(until)) {
    console.error(`--until: unparseable timestamp: ${untilRaw}`);
    process.exit(2);
  }
  // Unvalidated, a typo here (`--live-window-min 60min`) yields NaN, every
  // `lastActivity > until - NaN` is false, and the live-session exclusion this
  // guard exists to enforce silently switches itself off — moving the headline
  // with no error.
  const liveWindowMin = Number(arg("--live-window-min", DEFAULT_LIVE_WINDOW_MIN));
  if (!Number.isFinite(liveWindowMin) || liveWindowMin < 0) {
    console.error(`--live-window-min: expected a non-negative number of minutes, got: ${arg("--live-window-min")}`);
    process.exit(2);
  }
  const liveWindowMs = liveWindowMin * 60000;

  const recs = readLlmCalls(home);
  const nudges = recs.filter((r) => r.source === "nudge");
  // The SessionEnd distiller records `distill-remote` when it ships the
  // transcript to a server for ingestion and `distill-local` when it writes
  // nodes locally (scripts/engines/distill.js:362); this box is remote, so the
  // corpus is all `distill-remote`. Both are the same backstop, hence the
  // prefix match rather than an exact one.
  const distills = recs.filter((r) => String(r.source || "").startsWith("distill"));

  const distillBySession = new Map();
  for (const d of distills) {
    if (!d.session) continue;
    const prev = distillBySession.get(d.session) || [];
    prev.push(d);
    distillBySession.set(d.session, prev);
  }

  const index = indexTranscripts(transcripts);
  const timelines = new Map();
  const timelineFor = (session, strict) => {
    const key = `${session}|${strict ? 1 : 0}`;
    if (!timelines.has(key)) {
      const f = index.get(session);
      timelines.set(key, f ? sessionTimeline(f, strict, until) : null);
    }
    return timelines.get(key);
  };

  const stats = {
    calls: 0,
    afterCutoff: 0,
    errors: 0,
    nothing: 0,
    findings: 0,
    factsTotal: 0,
    scored: 0,
    lost: 0,
    lostFacts: 0,
    drained: 0,
    noSession: 0,
    noTranscript: 0,
    badTs: 0,
    stillLive: 0,
    lostStrict: 0,
    scoredStrict: 0,
    sessions: new Set(),
    lostSessions: new Set(),
  };
  const lostRecords = [];

  for (const r of nudges) {
    const at = Date.parse(r.ts); // stamped AFTER the backend returns (util.js
    // recordLlm), so this is when the worker's result file would exist.
    if (!Number.isNaN(at) && at > until) {
      stats.afterCutoff++;
      continue;
    }
    stats.calls++;
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
      stats.noSession++;
      continue;
    }
    stats.sessions.add(r.session);
    if (Number.isNaN(at)) {
      stats.badTs++;
      continue;
    }
    const tl = timelineFor(r.session, false);
    if (tl === null) {
      stats.noTranscript++;
      continue;
    }
    // A session still active near the cutoff has not ended: its spooled result
    // would drain at its next prompt, which simply hasn't happened yet. Scoring
    // it as a permanent loss inflates the rate.
    if (tl.lastActivity > until - liveWindowMs) {
      stats.stillLive++;
      continue;
    }
    stats.scored++;
    // Only prompts at or before the cutoff count, so the answer is stable as the
    // transcripts keep growing.
    const drained = tl.prompts.some((t) => t > at && t <= until);
    if (drained) stats.drained++;
    else {
      stats.lost++;
      stats.lostFacts += v.nfacts;
      stats.lostSessions.add(r.session);
      lostRecords.push({
        session: r.session,
        ts: r.ts,
        project: r.project,
        file: (r.vars || {}).FILE,
        facts: v.facts,
        nfacts: v.nfacts,
      });
    }

    const tls = timelineFor(r.session, true);
    if (tls !== null) {
      stats.scoredStrict++;
      if (!tls.prompts.some((t) => t > at && t <= until)) stats.lostStrict++;
    }
  }

  // Backstop: for each lost finding, did the SessionEnd distiller run for that
  // session, did it extract anything, and does what it extracted look like the
  // same fact? The first two are exact; the third is the lexical lower bound.
  let backstopRanFindings = 0;
  let backstopProductiveFindings = 0;
  const coverageSamples = [];
  const coveredAt = Object.fromEntries(THRESHOLDS.map((t) => [t, 0]));
  let lostFactsScored = 0;
  for (const L of lostRecords) {
    const ds = distillBySession.get(L.session) || [];
    if (!ds.length) continue;
    backstopRanFindings++;
    const productive = ds.some(
      (d) => !d.error && !String(d.response ?? "").includes("NOTHING") && String(d.response ?? "").trim()
    );
    if (!productive) continue;
    backstopProductiveFindings++;
    const distillWords = contentWords(ds.map((d) => String(d.response ?? "")).join("\n"));
    for (const fact of splitFacts(L.facts)) {
      lostFactsScored++;
      const c = coverage(fact, distillWords);
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

  // Join the census. Facts with no adjudication are reported, not assumed
  // either way — a stale census must never silently shrink the loss.
  let adjCovered = 0;
  let adjLost = 0;
  let adjMissing = 0;
  for (const s of coverageSamples) {
    const v = census.verdicts.get(s.key);
    if (v === undefined) adjMissing++;
    else if (v) adjCovered++;
    else adjLost++;
  }
  // Facts whose session produced no distiller extraction at all: nothing could
  // have covered them.
  const noBackstopFacts = stats.lostFacts - lostFactsScored;
  const durablyLost = adjMissing ? null : adjLost + noBackstopFacts;

  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");
  const out = {
    home,
    transcripts,
    until: new Date(until).toISOString(),
    liveWindowMin: liveWindowMs / 60000,
    calls: stats.calls,
    afterCutoff: stats.afterCutoff,
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
    excluded: {
      noSession: stats.noSession,
      noTranscript: stats.noTranscript,
      badTs: stats.badTs,
      stillLive: stats.stillLive,
    },
    sessionsWithFindings: stats.sessions.size,
    sessionsWithLoss: stats.lostSessions.size,
    backstopRanFindings,
    backstopProductiveFindings,
    lostFactsScored,
    coveredAt,
    coverageThreshold: COVERED_AT,
    adjudicated: { covered: adjCovered, missed: adjLost, unadjudicated: adjMissing },
    durablyLost,
  };

  if (asJson) {
    console.log(JSON.stringify({ ...out, lostRecords, coverageSamples }, null, 2));
    return;
  }

  console.log(`# Async capture-nudge session-final loss — counterfactual replay`);
  console.log(`  graph home:  ${home}`);
  console.log(`  transcripts: ${transcripts}`);
  console.log(`  corpus:      calls at or before ${new Date(until).toISOString()}`);
  console.log(`               (${stats.afterCutoff} later calls excluded; sessions active within`);
  console.log(`               ${liveWindowMs / 60000} min of the cutoff are treated as unfinished)`);
  console.log();
  console.log(`## Classifier calls (source=nudge)`);
  console.log(`  calls in corpus .............. ${stats.calls}`);
  console.log(`  backend errors (no result) ... ${stats.errors}`);
  console.log(`  NOTHING verdicts (no result) . ${stats.nothing}`);
  console.log(`  FINDINGS (≥1 fact) ........... ${stats.findings}   [${stats.factsTotal} facts, ${stats.sessions.size} sessions]`);
  console.log();
  console.log(`## Would the async drain have injected it?`);
  console.log(`  scored (ended session) ....... ${stats.scored}`);
  console.log(`  drained (a later prompt) ..... ${stats.drained}  ${pct(stats.drained, stats.scored)}`);
  console.log(`  LOST (no later prompt) ....... ${stats.lost}  ${pct(stats.lost, stats.scored)}   [${stats.lostFacts} facts, ${stats.lostSessions.size} sessions]`);
  console.log();
  console.log(`  excluded from the rate:`);
  console.log(`    session still active at cutoff .. ${stats.stillLive}  (not ended — would still drain)`);
  console.log(`    transcript missing .............. ${stats.noTranscript}`);
  console.log(`    journal row without a session ... ${stats.noSession}`);
  console.log(`    journal row with a bad ts ....... ${stats.badTs}`);
  console.log();
  console.log(`  sensitivity — human-typed prompts only (a different question:`);
  console.log(`  would a HUMAN have prompted again; system/sdk turns verified to fire the hook):`);
  console.log(`    scored ${stats.scoredStrict}, lost ${stats.lostStrict}  ${pct(stats.lostStrict, stats.scoredStrict)}`);
  console.log();
  console.log(`## Does the SessionEnd distiller back it up?`);
  console.log(`  lost findings ................ ${stats.lost}   [${stats.lostFacts} facts]`);
  console.log(`  ...whose session ran it ...... ${backstopRanFindings}  ${pct(backstopRanFindings, stats.lost)}  (findings)`);
  console.log(`  ...and it extracted facts .... ${backstopProductiveFindings}  ${pct(backstopProductiveFindings, stats.lost)}  (findings)`);
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
  console.log();
  console.log(`  NOTE: a floor, not a total — the sync path stops classifying after 3 fired`);
  console.log(`  nudges/session, so a session-final 4th+ prose write was never classified.`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  verdictFacts,
  isPromptEntry,
  coverage,
  contentWords,
  sessionTimeline,
  splitFacts,
  stem,
};
