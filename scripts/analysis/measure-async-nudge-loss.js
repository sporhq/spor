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
// KNOWN DRIFT — AND WHY THE WINDOW MOVED. `--until` pins the journal side, but
// the transcript side lives in ~/.claude/projects, which Claude Code prunes on
// its own retention schedule. An evicted transcript moves its finding from
// `scored` into the reported `transcript missing` bucket, so the rate drifts
// with no flag and the same cutoff — 41 of 117 findings at first run, and by
// 2026-09-04 ALL 117: the original 2026-07-17 corpus now scores zero findings
// and its numbers are unreproducible from the live box. That is why the default
// window moved to the replay pin below (2026-08-01 .. 2026-09-04) and why the
// pin commits the per-finding SessionEnd verdicts rather than only a census of
// hand-adjudicated facts: the derived verdicts outlive the transcripts they
// were derived from. Re-pin, don't re-cite, once these transcripts age out too.
//
//   node scripts/analysis/measure-async-nudge-loss.js [--home <dir>]
//        [--transcripts <dir>] [--from <iso>] [--until <iso>]
//        [--live-window-min <n>] [--drain-lag-sec <n>]
//        [--without-sessionend-drain] [--json]
//
// THE SHIPPED SESSIONEND DRAIN (the second run's whole point,
// task-spor-reevaluate-nudge-async-default-post-sessionend). The first run
// measured async against a client that had no SessionEnd surfacing, so a
// stranded result's only backstop was the SessionEnd DISTILLER re-deriving the
// same fact from the transcript in its own words — lossy, and adjudicated by
// hand. Since 2026-08-21 `sessionEndPendingNudges` (scripts/engines/distill.js)
// drains the leftover spool at SessionEnd and captures the classifier's OWN
// fact text, so a lost finding whose session fired SessionEnd needs no
// inference at all: it is captured verbatim. The replay therefore models that
// drain first and falls back to the distiller-coverage analysis only for the
// findings the drain could not reach. `--without-sessionend-drain` restores the
// pre-2026-08-21 model for continuity with the first run's artifact.
//
// WHY THE RESIDUAL IS A BOUND, NOT A CAUSE. A SessionEnd firing is only ever
// observed INDIRECTLY here — through the distiller's llm-calls row, or through
// a journal/distill.log line for a session that produced no row — and the
// absence of both is NOT proof the hook never fired. The gap cuts one way,
// though, and that asymmetry is what keeps the number usable:
// sessionEndPendingNudges runs at the TOP of distill(), AHEAD of the
// distill.enabled kill switch, the local-mode nodes/ check and the
// transcript-path/too-small gates, so a firing suppressed by any of those
// STILL DRAINED THE SPOOL — the finding was captured verbatim and merely left
// no trace. The one firing that skips the drain is the SPOR_DISTILLING
// recursion guard (distill.js:456, above both), and that one is excluded by
// construction: post-tool.js returns before classifying under the same marker,
// so a session carrying a classified finding never had it set.
//
// An unobserved firing is therefore either "never fired" (a real loss) or
// "fired and captured" — never a silent miss. So the residual is reported as a
// RANGE, not a point: `durablyLostUpper` counts every indeterminate case as
// lost, `durablyLostLower` counts only what the drain is DEMONSTRATED to have
// run on and missed, and the verdict is named `no-sessionend-observed` rather
// than `no-sessionend` so nothing downstream reads it as a demonstrated
// absence. Quote the range; the upper end alone is an assertion the journal
// cannot support.
//
// The second backstop below is NOT independent corroboration of that residual.
// A finding in the `no-sessionend-observed` bucket is there BECAUSE its session
// has no distiller llm-calls row, and "the distiller extracted nothing for this
// session" is read off that same missing row — so the bottom line's
// `no distiller extraction` count re-states the absence, it does not confirm
// it. Only a finding whose session DID record a distiller row gets a genuinely
// second opinion (the census/lexical analysis); the rest inherit the bound.
//
// EVERY DRAIN OBSERVABLE IS AN UPPER BOUND ON THE DRAIN MOMENT, NEVER THE
// MOMENT ITSELF. sessionEndPendingNudges runs at the very top of distill(), and
// BOTH observables are stamped strictly below it: the llm-calls row's backend
// start (`ts - latency_ms`) sits after the kill switch, the fs gates, a remote
// `drainOutbox`, the transcript read/parse, the touched-file scan, the template
// read and the 6s index fetch; a distill.log line for a row-less session sits
// after the same prefix minus the backend leg. So an observable at T proves the
// drain ran at some T' <= T, and reading T as T' is exactly the error that
// converts "the worker's result landed AFTER the drain" into "captured" —
// understating both ends of the loss.
//
// There is no hard ceiling on T - T' to lean on: drainOutbox iterates an
// UNCAPPED spool at 30s per file (x3 attempts), so a box with a large backlog
// can put minutes between the two. A constant "plausible lag" does NOT repair
// this — it only relocates the guess into a number nobody can check, and a
// capture verdict resting on it is still possibly a miss. So the replay closes
// the bracket from the OTHER end with recorded evidence instead, and every
// verdict it does reach holds at ANY lag (sessionEndOutcome):
//   captured               the result was on disk before the session's own last
//                          recorded transcript entry. SessionEnd fires only
//                          once the session has ENDED, and every entry is
//                          written while it is still running, so that entry is
//                          at or before T' — the EARLIEST moment the drain
//                          could have run. Lag-free.
//   too-late               the result was not on disk even at T, the LATEST
//                          moment it could have run. Lag-free.
//   drain-time-unresolved  in between — a firing IS observed, but whether it
//                          preceded or followed the result turns on a gap the
//                          journal does not record. Indeterminate, and charged
//                          to the upper bound with the unobserved bucket.
// The floor is refused when it runs past the latest observable firing (a
// resumed segment's entry says nothing about when the firing we can see ran),
// so it can never be read as being ABOVE the drain. `--drain-lag-sec` no longer
// decides anything: it survives only as a what-if the report prints beside the
// range — how many INDETERMINATE findings a chosen ceiling would have called
// captured — and the report prints the narrowest LAG-FREE capture margin, which
// is the closest any finding came to not being demonstrable at all.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { parseFactList } = require("../engines/post-tool.js");
const { isNothingVerdict } = require("../engines/util.js");

// Hand adjudication of every lost fact against its session's distiller output,
// keyed by sha256(session|fact) so it survives re-runs and re-orderings. The
// lexical score below is only a lower bound — it charges a real capture as a
// miss whenever the distiller restated the fact in its own words, which is most
// of the time — so the headline coverage number comes from this census instead.
// It also pins the corpus: its `until` is the default cutoff, so a plain re-run
// reproduces the committed numbers even though the live journal keeps growing.
const ADJUDICATION = path.join(__dirname, "adjudication-2026-07-17.json");

// The second run's pin. Unlike the census this is a RESULT, not a lookup table:
// the transcripts the SessionEnd verdicts were derived from get pruned (see
// KNOWN DRIFT above), so the derived verdicts are committed to keep the quoted
// numbers auditable after the corpus evaporates. It also supplies the default
// window, so a plain re-run reproduces the committed numbers while the live
// journal keeps growing. A re-run inside the window joins it and reports any
// disagreement per finding — drift is surfaced, never silently absorbed.
const REPLAY_PIN = path.join(__dirname, "sessionend-replay-2026-09-04.json");

// A session whose transcript went quiet less than this before the cutoff may
// still be running, and a still-open session's finding is not lost — its next
// prompt simply hasn't happened yet. Those are excluded, not scored.
const DEFAULT_LIVE_WINDOW_MIN = 60;

// SENSITIVITY ONLY — no verdict, and therefore no reported number, depends on
// this constant (F5). It is a plausible guess at how much EARLIER than its
// observable the drain could have run: the work between them is a remote
// `drainOutbox` plus local IO, one outbox file's worst case is 30s x 3 attempts
// (drain-outbox.js: timeoutMs = maxTimeSec * 1000, retry 2), and the llm-calls
// observable adds the 6s index fetch — 96s, rounded up to two minutes.
//
// An earlier revision of this script used it as the capture RULE: a result that
// beat its observable by more than this was scored `captured`. That was
// unsound and the review was right to refuse it — drainOutbox takes no file cap
// from distill.js, so no constant bounds the gap, and any constant chosen
// silently converts "the result may have landed after the drain" into
// "surfaced". The capture rule is now derived from evidence instead
// (`activityFloor`, see sessionEndOutcome) and holds at ANY lag. This survives
// as `--drain-lag-sec`, which reports how many INDETERMINATE findings would
// read as captured if you chose to grant a ceiling of that size — an explicit
// what-if beside the headline, never inside it.
const DRAIN_OBSERVABLE_LAG_MS = 120000;

// A classifier result is only worth draining when it found ≥1 fact — the async
// worker writes NO result file for a NOTHING verdict or a backend failure
// (scripts/engines/nudge-worker.js), so those can never be "lost".
function verdictFacts(rec) {
  if (rec.error) return null; // backend failed: no result written, nothing to lose
  const response = String(rec.response ?? "");
  const facts = parseFactList(response);
  if (isNothingVerdict(response, facts === "" ? 0 : 1)) return { nfacts: 0, facts: "" };
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

// When did SessionEnd run for a session? The hook itself journals nothing
// unconditionally, so the observable is its DISTILLER call: the llm-calls row is
// stamped after the backend returns, and sessionEndPendingNudges runs at the top
// of distill(), so `ts - latency_ms` — the moment the backend call STARTED —
// brackets the drain from ABOVE. Multiple rows mean a resumed session ended more
// than once; every one of them is a drain opportunity, because an undrained
// result file persists until some SessionEnd consumes it.
//
// From above, and not tightly: between the drain and the backend start lie the
// kill switch, the fs gates, a remote drainOutbox, the transcript read/parse,
// the touched-file scan, the template read and the index fetch. So these are
// UPPER bounds on the drain moment, and sessionEndOutcome must not read one as
// the moment itself — see EVERY DRAIN OBSERVABLE IS AN UPPER BOUND above.
//
// The set of firings is also a LOWER bound, and deliberately so: the drain sits
// ahead of the distill.enabled kill switch and the missing/too-small transcript
// gates, so a firing that produced no llm-calls row may still have drained.
// Counting only demonstrated firings makes the residual loss an UPPER bound —
// the honest direction for a number that argues against flipping a default, and
// the reason the bottom line reports a RANGE (see WHY THE RESIDUAL IS A BOUND
// above). distillLogDrains below narrows that gap by one documented case; the
// rest of it is irreducible from the journal.
function sessionEndDrains(distillRecords) {
  const out = [];
  for (const d of distillRecords || []) {
    const at = Date.parse(d.ts);
    if (Number.isNaN(at)) continue;
    const latency = Number(d.latency_ms);
    out.push(at - (Number.isFinite(latency) && latency > 0 ? latency : 0));
  }
  return out.sort((a, b) => a - b);
}

// SECOND observable for a firing, for the sessions the llm-calls journal is
// blind to. `journal/distill.log` is opened at distill.js:494 — after the drain,
// after the kill switch, but BEFORE the too-small-transcript exit that returns
// without ever reaching the backend. That exit is the one path that fires,
// drains, and records no llm-calls row at all, so without this reader such a
// session reads as "SessionEnd never fired" and its finding is charged to the
// residual.
//
// Like the row stamp this is an UPPER bound on the drain, not the drain: the
// line lands after the kill switch, the fs gates, a remote drainOutbox and the
// transcript read. Its POSITION in distill() is earlier than the backend start
// the row bracket uses, so it is the tighter of the two — but "tighter" is not
// "tight", and sessionEndOutcome brackets both the same way rather than
// trusting either as the drain moment (F4). The stamp is also SECOND-precision,
// so it can read up to 999ms early; that error runs the conservative way (an
// earlier apparent drain never manufactures a capture).
//
// Lines are `[<iso-seconds>] <session>: <msg>`; only the session-prefixed head
// of a record matches (continuation lines are indented and unprefixed).
//
// Used ONLY for sessions with no distill row (main below). Every log line that
// lands after a backend call belongs to a firing that recorded a row — recordLlm
// runs on the error paths too (distill.js `distill cmd failed` / `claude -p
// failed`) — so a row-less session's lines can only come from the pre-backend
// exits, and this reader never picks up a 120s-timeout line as if it were a
// drain.
function distillLogDrains(logText, session) {
  const out = [];
  if (!logText || !session) return out;
  const head = `] ${session}: `;
  for (const line of String(logText).split("\n")) {
    if (!line.startsWith("[")) continue;
    const close = line.indexOf(head);
    if (close < 0) continue;
    const t = Date.parse(line.slice(1, close));
    if (!Number.isNaN(t)) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

// The distiller's own operability log, read once. Absent is fine — it only
// exists once some session got past the kill switch.
function readDistillLog(home) {
  try {
    return fs.readFileSync(path.join(home, "journal", "distill.log"), "utf8");
  } catch {
    return "";
  }
}

// How much earlier would a moment `before` in this session have arrived under
// async? Exactly the tool-loop time the synchronous path spent blocked between
// this call and that moment: this call's own latency, plus every later
// classifier call's up to it. (Blocks BEFORE this call shift the result file
// and everything downstream by the SAME amount, so they cancel — see
// sessionEndOutcome.) Errors and NOTHING verdicts count: they produce no result
// file but they did block the loop.
//
// Every comparison against the async clock takes its shift from here, so that
// the two events being compared are corrected consistently. Passing a moment
// (rather than always summing the whole tail) is what lets the PROMPT drain use
// it: a prompt two calls later gets back only the blocking that preceded IT,
// not the blocking of calls that happen after it.
function asyncShiftBefore(call, sessionCalls, before = Infinity) {
  const at = Date.parse(call.ts);
  let shift = 0;
  for (const c of sessionCalls || []) {
    const t = Date.parse(c.ts);
    if (Number.isNaN(t) || t < at || t >= before) continue;
    const latency = Number(c.latency_ms);
    if (Number.isFinite(latency) && latency > 0) shift += latency;
  }
  return shift;
}

// The SessionEnd case: the session's end is after every call in it, so the
// shift is the whole tail.
function asyncEndShift(call, sessionCalls) {
  return asyncShiftBefore(call, sessionCalls, Infinity);
}

// Would a prompt at `promptAt` have drained the spooled result of `call`?
//
// NOT `promptAt > resultAt`. Both events move under async and they do NOT move
// together: the result file appears when the worker answers, which is the
// classifier latency after the tool call either way, so it keeps its place on
// the timeline minus the blocking that PRECEDED the call; the prompt loses that
// same preceding blocking PLUS this call's and every intervening call's, since
// none of it is on the tool loop any more. The shared term cancels and the test
// is `promptAt - resultAt > shift`, exactly the form sessionEndOutcome uses.
//
// Scoring a prompt on the synchronous clock silently converts a race into a
// clean drain: a prompt 2s after a classifier that blocked for 5s happens
// BEFORE the async result exists, and the finding is stranded, not drained.
function promptDrains({ resultAt, promptAt, shiftMs }) {
  return promptAt - resultAt > shiftMs;
}

// Would the shipped SessionEnd drain have surfaced this stranded finding?
//
// Both sides of the comparison are measured on the SYNCHRONOUS timeline the
// journal actually recorded, then corrected onto the async one:
//   result ready:  t1 (the row's ts) minus the blocking that PRECEDED the call
//   drain runs:    tEnd minus that same preceding blocking, minus `shift`
// The shared term cancels, leaving `tEnd - t1 > shift` — i.e. the session's
// remaining wall-clock after the classifier answered must exceed the tool-loop
// time async gives back. Margin is that slack.
//
// `tEnd` is an OBSERVABLE, though, not the drain: both readers above are
// stamped below sessionEndPendingNudges, so the real drain ran at some
// tEnd - lag with lag >= 0 and no journal record of it. Guessing `captured`
// inside that gap is the direction that hides loss — a result written after the
// drain but before the observable would read as surfaced (F4) — and no constant
// bounds the gap, so a ceiling cannot repair the guess either, it only relocates
// it into a number nobody can check (F5).
//
// So the bracket is closed from BOTH ends with recorded evidence, and no
// verdict depends on a chosen constant:
//
//   UPPER end — the observable. The drain ran at or before it (both readers are
//   stamped strictly below sessionEndPendingNudges). A result not on disk even
//   then was not on disk at the drain: `too-late`, sound at any lag.
//
//   LOWER end — `activityFloor`, the session's own last recorded activity
//   (sessionTimeline's lastActivity, clamped to the corpus cutoff). SessionEnd
//   fires when the session ENDS, and every transcript entry is written while it
//   is still running, so the drain ran at or after the last entry. A result on
//   disk before that moment was on disk at the drain: `captured`, and — this is
//   the point — sound at any lag, because it never reads the observable as the
//   drain at all.
//
// The floor is only admitted when it does not run PAST the latest observable
// firing. A transcript that grew beyond the last firing we can see is a resumed
// session whose later segment left no observable, and its last entry then says
// nothing about when the firing we DID see ran; scoring against it would put
// the floor above the drain and manufacture the capture this rule exists to
// avoid. Such a finding falls through to indeterminate.
//
//   margin(floor) > 0   captured             lag-free: on disk before the
//                                            EARLIEST moment the drain could
//                                            have run.
//   margin(observable) <= 0
//                       too-late             lag-free: not on disk even at the
//                                            LATEST moment it could have run.
//   otherwise           drain-time-unresolved a firing is observed, but the
//                                            verdict turns on a gap the journal
//                                            does not record.
//
// Both indeterminate verdicts are charged to the upper bound and withheld from
// the lower one, so nothing here can shrink the reported loss on an assumption.
// `lagMs` no longer decides anything; it is carried through as `withinCeiling`
// purely so the report can say how many indeterminate findings a chosen ceiling
// WOULD have called captured (see DRAIN_OBSERVABLE_LAG_MS).
//
// RESIDUAL, written down rather than papered over: a session that resumed
// INSIDE the drain-to-observable gap, wrote one entry there, and then went
// silent without producing a firing of its own would put an entry after the
// drain yet still at or before the observable, admitting a floor that is
// marginally too high. It needs a resume landing in a gap of seconds-to-minutes
// followed by silence, and unlike the ceiling it is not a free parameter — it
// is a bounded, nameable construction rather than a number chosen to make the
// captures come out.
function sessionEndOutcome({ resultAt, shiftMs, activityFloor }, drains, lagMs = DRAIN_OBSERVABLE_LAG_MS) {
  // "observed" is load-bearing: no row and no distill.log line is an absence of
  // EVIDENCE, not evidence of absence, and every downstream tally treats this
  // bucket as indeterminate rather than as a demonstrated loss. See WHY THE
  // RESIDUAL IS A BOUND at the top.
  if (!drains || !drains.length) {
    return { verdict: "no-sessionend-observed", marginMs: null, floorMarginMs: null, withinCeiling: false };
  }
  // Not drains[drains.length - 1]: both readers sort, but a caller that does not
  // would silently pick the wrong end and the floor guard below would admit a
  // floor past the latest firing — the one thing it exists to refuse.
  let latest = -Infinity;
  let best = -Infinity;
  for (const d of drains) {
    if (d > latest) latest = d;
    const m = d - resultAt - shiftMs;
    if (m > best) best = m;
  }
  // Ordered before the floor on purpose: floor <= latest, so a result that
  // missed the latest observable missed the floor too. Checking the floor first
  // could only ever agree, never disagree — this way the cheap sound verdict
  // wins and the two can never contradict each other.
  if (best <= 0) return { verdict: "too-late", marginMs: best, floorMarginMs: null, withinCeiling: false };
  const floorUsable = Number.isFinite(activityFloor) && activityFloor > 0 && activityFloor <= latest;
  const floorMarginMs = floorUsable ? activityFloor - resultAt - shiftMs : null;
  if (floorMarginMs !== null && floorMarginMs > 0) {
    return { verdict: "captured", marginMs: best, floorMarginMs, withinCeiling: true };
  }
  const lag = Number.isFinite(lagMs) && lagMs > 0 ? lagMs : 0;
  return { verdict: "drain-time-unresolved", marginMs: best, floorMarginMs, withinCeiling: best > lag };
}

const COVERED_AT = 0.6;
const THRESHOLDS = [0.3, 0.4, 0.5, 0.6];

function factKey(session, fact) {
  return crypto.createHash("sha256").update(`${session}|${fact}`).digest("hex").slice(0, 12);
}

// One stranded finding's identity in the replay pin. The classifier row's own
// timestamp is in the key, so a session that stranded two findings keys them
// apart and a re-run can only match a verdict to the call it was derived from.
function findingKey(session, ts, file) {
  return crypto
    .createHash("sha256")
    .update(`${session}|${ts}|${file ?? ""}`)
    .digest("hex")
    .slice(0, 12);
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

// Same posture as loadAdjudication: an absent pin is fine (the replay just runs
// unpinned), a malformed one must fail loudly rather than read as "no drift".
//
// The pin carries EVERY SCORED finding, not only the lost ones. The headline is
// a rate, and a pin holding just the numerator cannot be audited once the
// transcripts that produced the denominator are pruned — `findingsScored`,
// `drained` and `factsTotal` would be bare assertions with no rows behind them.
// Each row therefore carries its drain outcome (`drained` | `lost`) and its
// fact count, so the denominator is derivable from the file alone, and a re-run
// joins on BOTH the drain outcome and the SessionEnd verdict: a finding that
// flips from drained to lost is exactly the drift this pin exists to catch, and
// it never appears in the lost rows.
function loadReplayPin() {
  let raw;
  try {
    raw = fs.readFileSync(REPLAY_PIN, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { rows: new Map(), from: null, until: null };
    throw e;
  }
  const doc = JSON.parse(raw); // deliberately unguarded — a typo must not read as an empty pin
  return {
    rows: new Map(
      (doc.findings || []).map((f) => [
        f.key,
        // `drain` is derived for a pre-denominator pin: those files listed lost
        // findings only, so a row without the field is a lost one.
        { drain: f.drain || "lost", verdict: f.verdict ?? null, nfacts: f.nfacts ?? null },
      ])
    ),
    from: doc.from || null,
    until: doc.until || null,
  };
}

const FLAGS = ["--home", "--transcripts", "--from", "--until", "--live-window-min", "--drain-lag-sec"];
const BOOLEAN_FLAGS = ["--json", "--without-sessionend-drain"];

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
    if (BOOLEAN_FLAGS.includes(a)) {
      parsed.set(a, true);
      continue;
    }
    if (!FLAGS.includes(a)) {
      console.error(`unknown flag: ${a}\nusage: [${FLAGS.join(" <v>] [")} <v>] [${BOOLEAN_FLAGS.join("] [")}]`);
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
  const modelSessionEndDrain = !parsed.has("--without-sessionend-drain");
  const census = loadAdjudication();
  const pin = loadReplayPin();
  // Pin the corpus to the replay pin's window by default: the journal grows
  // every session, so an unpinned run re-stales the pin within hours and the
  // headline stops being reproducible. The census's own (earlier) cutoff is no
  // longer the default — its transcripts are gone, so that window now scores
  // nothing at all; see KNOWN DRIFT.
  const untilRaw = arg("--until", pin.until);
  const until = untilRaw ? Date.parse(untilRaw) : Date.now();
  if (Number.isNaN(until)) {
    console.error(`--until: unparseable timestamp: ${untilRaw}`);
    process.exit(2);
  }
  const fromRaw = arg("--from", pin.from);
  const from = fromRaw ? Date.parse(fromRaw) : -Infinity;
  if (Number.isNaN(from)) {
    console.error(`--from: unparseable timestamp: ${fromRaw}`);
    process.exit(2);
  }
  if (from > until) {
    console.error(`--from is after --until: ${fromRaw} > ${untilRaw}`);
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
  // Same guard as --live-window-min. This one no longer moves a verdict — the
  // ceiling is a what-if now — but a NaN would silently zero the sensitivity
  // line beside the range, which reads as "no finding is anywhere near the
  // bracket" when the truth is that the flag was misspelt.
  const drainLagSec = Number(arg("--drain-lag-sec", DRAIN_OBSERVABLE_LAG_MS / 1000));
  if (!Number.isFinite(drainLagSec) || drainLagSec < 0) {
    console.error(
      `--drain-lag-sec: expected a non-negative number of seconds, got: ${arg("--drain-lag-sec")}`
    );
    process.exit(2);
  }
  const drainLagMs = drainLagSec * 1000;

  const recs = readLlmCalls(home);
  // Second SessionEnd observable, for sessions the llm-calls journal missed.
  const distillLog = readDistillLog(home);
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

  // Every classifier call of a session, windowed by nothing: asyncEndShift sums
  // the blocking that happened AFTER a stranded call, and a later call sits
  // outside the corpus cutoff as easily as inside it. Clipping this index to
  // the window would under-count the shift and score a race as a clean capture.
  const nudgeBySession = new Map();
  for (const n of nudges) {
    if (!n.session) continue;
    const prev = nudgeBySession.get(n.session) || [];
    prev.push(n);
    nudgeBySession.set(n.session, prev);
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
    beforeWindow: 0,
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
  // EVERY scored finding, drained or lost — the pin's denominator rows (F3).
  const scoredSamples = [];

  for (const r of nudges) {
    const at = Date.parse(r.ts); // stamped AFTER the backend returns (util.js
    // recordLlm), so this is when the worker's result file would exist.
    if (!Number.isNaN(at) && at > until) {
      stats.afterCutoff++;
      continue;
    }
    if (!Number.isNaN(at) && at < from) {
      stats.beforeWindow++;
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
    const sessionCalls = nudgeBySession.get(r.session);
    // Only prompts at or before the cutoff count, so the answer is stable as the
    // transcripts keep growing — and each is tested on the ASYNC clock
    // (promptDrains), not on the synchronous one the journal recorded.
    const drains = (prompts) =>
      prompts.some(
        (t) =>
          t <= until &&
          promptDrains({ resultAt: at, promptAt: t, shiftMs: asyncShiftBefore(r, sessionCalls, t) })
      );
    const drained = drains(tl.prompts);
    const key = findingKey(r.session, r.ts, (r.vars || {}).FILE);
    scoredSamples.push({
      key,
      session: r.session,
      ts: r.ts,
      file: (r.vars || {}).FILE,
      nfacts: v.nfacts,
      drain: drained ? "drained" : "lost",
    });
    if (drained) stats.drained++;
    else {
      stats.lost++;
      stats.lostFacts += v.nfacts;
      stats.lostSessions.add(r.session);
      lostRecords.push({
        key,
        session: r.session,
        ts: r.ts,
        at,
        project: r.project,
        file: (r.vars || {}).FILE,
        facts: v.facts,
        nfacts: v.nfacts,
        shiftMs: asyncEndShift(r, sessionCalls),
        // The LOWER end of the drain bracket: SessionEnd cannot have fired
        // before the session's own last recorded entry. Already clamped to the
        // cutoff by sessionTimeline, so it stays reproducible as the transcript
        // grows. See sessionEndOutcome.
        activityFloor: tl.lastActivity,
      });
    }

    const tls = timelineFor(r.session, true);
    if (tls !== null) {
      stats.scoredStrict++;
      if (!drains(tls.prompts)) stats.lostStrict++;
    }
  }

  // FIRST backstop: the shipped SessionEnd drain. A finding it reaches is
  // captured VERBATIM — the classifier's own fact text goes straight through
  // the capture path — so it needs no coverage inference and drops out of the
  // distiller analysis below entirely. `uncovered` is what is left for that
  // weaker, lossier backstop to argue about.
  const sessionEnd = {
    captured: 0,
    capturedFacts: 0,
    tooLate: 0,
    tooLateFacts: 0,
    // A firing IS observed, but the drain-to-observable lag decides the verdict
    // and the journal does not record it. Indeterminate, like `unobserved`.
    unresolved: 0,
    unresolvedFacts: 0,
    unobserved: 0,
    unobservedFacts: 0,
    // Of `unresolved`, how many `--drain-lag-sec` would have called captured.
    unresolvedWithinCeiling: 0,
    unresolvedWithinCeilingFacts: 0,
  };
  let narrowestMarginMs = null;
  let narrowestFloorMarginMs = null;
  const uncovered = [];
  const replaySamples = [];
  const verdictByKey = new Map();
  for (const L of lostRecords) {
    if (!modelSessionEndDrain) {
      uncovered.push(L);
      continue;
    }
    // llm-calls rows first; distill.log only for a session with NO row, so a
    // firing's loose (post-backend) bracket can never displace its tight one.
    const rows = distillBySession.get(L.session);
    const drains = rows && rows.length ? sessionEndDrains(rows) : distillLogDrains(distillLog, L.session);
    const { verdict, marginMs, floorMarginMs, withinCeiling } = sessionEndOutcome(
      { resultAt: L.at, shiftMs: L.shiftMs, activityFloor: L.activityFloor },
      drains,
      drainLagMs
    );
    L.sessionEnd = verdict;
    L.marginMs = marginMs;
    L.floorMarginMs = floorMarginMs;
    verdictByKey.set(L.key, verdict);
    replaySamples.push({
      key: L.key,
      session: L.session,
      ts: L.ts,
      file: L.file,
      nfacts: L.nfacts,
      verdict,
      marginMs,
      floorMarginMs,
      shiftMs: L.shiftMs,
    });
    if (verdict === "captured") {
      sessionEnd.captured++;
      sessionEnd.capturedFacts += L.nfacts;
      // The narrowest LAG-FREE slack: how close the closest capture came to not
      // being demonstrable at all. The old headline reported the margin to the
      // observable instead, which was the breakeven on a ceiling that no longer
      // decides anything.
      if (narrowestFloorMarginMs === null || floorMarginMs < narrowestFloorMarginMs) {
        narrowestFloorMarginMs = floorMarginMs;
      }
      if (narrowestMarginMs === null || marginMs < narrowestMarginMs) narrowestMarginMs = marginMs;
      continue;
    }
    if (verdict === "too-late") {
      sessionEnd.tooLate++;
      sessionEnd.tooLateFacts += L.nfacts;
    } else if (verdict === "drain-time-unresolved") {
      sessionEnd.unresolved++;
      sessionEnd.unresolvedFacts += L.nfacts;
      // Sensitivity, not a verdict: how much of the indeterminate bucket a
      // chosen drain-to-observable ceiling would have called captured.
      if (withinCeiling) {
        sessionEnd.unresolvedWithinCeiling++;
        sessionEnd.unresolvedWithinCeilingFacts += L.nfacts;
      }
    } else {
      sessionEnd.unobserved++;
      sessionEnd.unobservedFacts += L.nfacts;
    }
    uncovered.push(L);
  }
  const uncoveredFacts = uncovered.reduce((n, L) => n + L.nfacts, 0);

  // Join the pin over EVERY scored finding, not just the lost ones: the drift
  // that matters most — a finding that was drained in the pin and is stranded
  // now, or the reverse — moves a row between the two populations, so a join
  // restricted to the lost rows would see it as a disappearance and report
  // nothing (F3). Comparing the pair (drain outcome, SessionEnd verdict) puts
  // every scored row under the check.
  const pinAgreed = [];
  const pinDrifted = [];
  for (const S of scoredSamples) {
    const pinned = pin.rows.get(S.key);
    if (pinned === undefined) continue;
    const verdict = verdictByKey.get(S.key) ?? null;
    const same =
      pinned.drain === S.drain &&
      (!modelSessionEndDrain || (pinned.verdict ?? null) === verdict) &&
      (pinned.nfacts === null || pinned.nfacts === S.nfacts);
    (same ? pinAgreed : pinDrifted).push({
      key: S.key,
      pinned: `${pinned.drain}/${pinned.verdict ?? "-"}/${pinned.nfacts ?? "?"}f`,
      verdict: `${S.drain}/${verdict ?? "-"}/${S.nfacts}f`,
    });
  }

  // SECOND backstop, for whatever the drain could not reach: did the SessionEnd
  // distiller run for that session, did it extract anything, and does what it
  // extracted look like the same fact? The first two are exact; the third is the
  // lexical lower bound.
  let backstopRanFindings = 0;
  let backstopProductiveFindings = 0;
  const coverageSamples = [];
  const coveredAt = Object.fromEntries(THRESHOLDS.map((t) => [t, 0]));
  let lostFactsScored = 0;
  for (const L of uncovered) {
    const ds = distillBySession.get(L.session) || [];
    if (!ds.length) continue;
    backstopRanFindings++;
    const productive = ds.some(
      (d) => {
        // The engine's rule (u.isNothingVerdict over the engine's own block
        // parsers): NOTHING only as an exact line with no completed fact/node
        // block beside it. Either mode's parser may apply to a record.
        const r = String(d.response ?? "");
        const { parseFactBlocks, parseNodeBlocks } = require("../engines/distill.js");
        const blocks = Math.max(parseFactBlocks(r).length, parseNodeBlocks(r).length);
        return !d.error && !isNothingVerdict(r, blocks) && r.trim();
      }
    );
    if (!productive) continue;
    backstopProductiveFindings++;
    const distillWords = contentWords(ds.map((d) => String(d.response ?? "")).join("\n"));
    L.factKeys = [];
    for (const fact of splitFacts(L.facts)) {
      lostFactsScored++;
      const c = coverage(fact, distillWords);
      const k = factKey(L.session, fact);
      L.factKeys.push(k);
      coverageSamples.push({
        key: k,
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
  // Facts whose session produced no distiller extraction at all. For a finding
  // in the `no-sessionend-observed` bucket this is the SAME missing llm-calls
  // row that put it there, so it re-states the absence rather than confirming
  // it independently (see WHY THE RESIDUAL IS A BOUND); only a finding whose
  // session did record a distiller row gets a genuine second opinion.
  const noBackstopFacts = uncoveredFacts - lostFactsScored;

  // The bottom line is a RANGE, not a point (F1). Attribute each durably-lost
  // fact to the finding it came from, then split on whether the drain is
  // DEMONSTRATED to have run on it and missed:
  //   lower — only `too-late` findings, where an observed firing provably
  //           post-dates nothing: the result was not on disk even at the latest
  //           drain moment the bracket allows.
  //   upper — additionally every INDETERMINATE finding, whether the firing was
  //           unobserved (`no-sessionend-observed`) or observed with a drain
  //           moment the journal does not pin down (`drain-time-unresolved`).
  // Both ends are reachable from the evidence; nothing in the journal picks
  // between them, so the honest report carries both. There is deliberately no
  // point total: any single number here is an assertion about the indeterminate
  // bucket that the journal cannot support, which is how the first cut read
  // "no distiller llm-calls row" as "the session never fired SessionEnd".
  const INDETERMINATE = new Set(["no-sessionend-observed", "drain-time-unresolved"]);
  const factsDurablyLost = (L) => {
    if (!L.factKeys) return L.nfacts; // no distiller extraction: nothing could cover it
    return L.factKeys.filter((k) => census.verdicts.get(k) === false).length;
  };
  let durablyLostUpper = 0;
  let durablyLostLower = 0;
  let indeterminateFacts = 0;
  for (const L of uncovered) {
    const n = factsDurablyLost(L);
    durablyLostUpper += n;
    if (INDETERMINATE.has(L.sessionEnd)) indeterminateFacts += n;
    else durablyLostLower += n;
  }
  // An unadjudicated fact means the census is stale, so the bounds are reported
  // as "?" rather than as numbers that silently shrink the loss. The pre-change
  // arithmetic is kept only as an internal cross-check on the attribution — it
  // is NOT emitted, because a bare `durablyLost` field is exactly the point
  // claim the range exists to replace.
  const durablyLostCheck = adjMissing ? null : adjLost + noBackstopFacts;
  if (durablyLostCheck !== null && durablyLostCheck !== durablyLostUpper) {
    throw new Error(`internal: durably-lost attribution disagrees (${durablyLostCheck} vs ${durablyLostUpper})`);
  }
  if (durablyLostLower + indeterminateFacts !== durablyLostUpper) {
    throw new Error(
      `internal: the residual range does not decompose (${durablyLostLower} + ${indeterminateFacts} != ${durablyLostUpper})`
    );
  }

  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");
  const out = {
    home,
    transcripts,
    from: Number.isFinite(from) ? new Date(from).toISOString() : null,
    until: new Date(until).toISOString(),
    modelSessionEndDrain,
    liveWindowMin: liveWindowMs / 60000,
    calls: stats.calls,
    afterCutoff: stats.afterCutoff,
    beforeWindow: stats.beforeWindow,
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
    sessionEnd,
    narrowestMarginMs,
    narrowestFloorMarginMs,
    uncovered: uncovered.length,
    uncoveredFacts,
    pin: { agreed: pinAgreed.length, drifted: pinDrifted, size: pin.rows.size },
    backstopRanFindings,
    backstopProductiveFindings,
    lostFactsScored,
    coveredAt,
    coverageThreshold: COVERED_AT,
    adjudicated: { covered: adjCovered, missed: adjLost, unadjudicated: adjMissing },
    drainLagSec,
    durablyLostUpper: adjMissing ? null : durablyLostUpper,
    durablyLostLower: adjMissing ? null : durablyLostLower,
    indeterminateFacts: adjMissing ? null : indeterminateFacts,
  };

  if (asJson) {
    console.log(JSON.stringify({ ...out, lostRecords, scoredSamples, replaySamples, coverageSamples }, null, 2));
    return;
  }

  console.log(`# Async capture-nudge session-final loss — counterfactual replay`);
  console.log(`  graph home:  ${home}`);
  console.log(`  transcripts: ${transcripts}`);
  console.log(
    `  corpus:      calls in [${Number.isFinite(from) ? new Date(from).toISOString() : "-∞"} .. ${new Date(
      until
    ).toISOString()}]`
  );
  console.log(`               (${stats.afterCutoff} later + ${stats.beforeWindow} earlier calls excluded; sessions`);
  console.log(`               active within ${liveWindowMs / 60000} min of the cutoff are treated as unfinished)`);
  console.log(
    `  model:       ${
      modelSessionEndDrain
        ? "the SHIPPED client — sessionEndPendingNudges drains the leftover spool"
        : "pre-2026-08-21 — no SessionEnd drain (--without-sessionend-drain)"
    }`
  );
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
  if (modelSessionEndDrain) {
    console.log(`## Does the shipped SessionEnd drain surface it? (sessionEndPendingNudges)`);
    console.log(`  lost findings ................ ${stats.lost}   [${stats.lostFacts} facts]`);
    console.log(
      `  captured VERBATIM at SessionEnd ${sessionEnd.captured}  ${pct(sessionEnd.captured, stats.lost)}  [${
        sessionEnd.capturedFacts
      } facts]`
    );
    console.log(
      `  result landed after the drain . ${sessionEnd.tooLate}  ${pct(sessionEnd.tooLate, stats.lost)}  [${
        sessionEnd.tooLateFacts
      } facts]`
    );
    console.log(
      `  drain time UNRESOLVED ......... ${sessionEnd.unresolved}  ${pct(sessionEnd.unresolved, stats.lost)}  [${
        sessionEnd.unresolvedFacts
      } facts]  (indeterminate — see below)`
    );
    console.log(
      `  no SessionEnd OBSERVED ........ ${sessionEnd.unobserved}  ${pct(sessionEnd.unobserved, stats.lost)}  [${
        sessionEnd.unobservedFacts
      } facts]  (indeterminate — see below)`
    );
    console.log();
    console.log(`  NO verdict above depends on a chosen constant. Both observables are stamped`);
    console.log(`  BELOW sessionEndPendingNudges in distill(), so each is an UPPER bound on the`);
    console.log(`  drain and never the drain itself, and no constant bounds the gap between the`);
    console.log(`  two. The bracket is therefore closed from both ends with recorded evidence:`);
    console.log(`    too-late  the result was not on disk even at the observable — the LATEST`);
    console.log(`              moment the drain could have run.`);
    console.log(`    captured  the result was on disk before the session's last recorded entry —`);
    console.log(`              the EARLIEST moment it could have run, since SessionEnd fires`);
    console.log(`              only once the session has ended.`);
    console.log(`  Both hold at ANY drain-to-observable lag; anything in between is left`);
    console.log(`  indeterminate rather than decided.`);
    if (narrowestFloorMarginMs !== null) {
      console.log();
      console.log(
        `  narrowest capture margin ..... ${Math.round(narrowestFloorMarginMs / 1000)}s of slack (lag-free)`
      );
      console.log(`  (async reaches the session's end earlier by the tool-loop time it gives`);
      console.log(`   back; a capture needs the wall-clock between the result and the session's`);
      console.log(`   last recorded entry to exceed that. This is the closest any finding in the`);
      console.log(`   corpus came to losing that race.)`);
    }
    if (sessionEnd.unresolved) {
      console.log();
      console.log(`  "drain time unresolved" means a SessionEnd firing IS observed for the`);
      console.log(`  session, but the result landed between the earliest and latest moment the`);
      console.log(`  drain could have run, and the journal records neither. Counted with the`);
      console.log(`  unobserved bucket in the upper bound, never in the lower.`);
      console.log(
        `    of which a ${Math.round(drainLagMs / 1000)}s ceiling would call captured: ${
          sessionEnd.unresolvedWithinCeiling
        }  [${sessionEnd.unresolvedWithinCeilingFacts} facts]  (--drain-lag-sec)`
      );
      console.log(`    That is a WHAT-IF, deliberately outside the range below: drainOutbox takes`);
      console.log(`    no file cap from distill.js, so no constant bounds the gap and a ceiling`);
      console.log(`    only relocates the guess into a number nobody can check.`);
    }
    if (sessionEnd.unobserved) {
      console.log();
      console.log(`  "no SessionEnd observed" is an absence of EVIDENCE, not a demonstrated`);
      console.log(`  absence: the only observables are the distiller's llm-calls row and its`);
      console.log(`  journal/distill.log line, and both sit BELOW the drain in distill(). A`);
      console.log(`  firing stopped by the distill.enabled kill switch, the local-mode nodes/`);
      console.log(`  check or a missing transcript_path drained the spool and left no trace —`);
      console.log(`  those findings were CAPTURED. The only firing that skips the drain is the`);
      console.log(`  SPOR_DISTILLING recursion guard, excluded by construction (post-tool.js`);
      console.log(`  does not classify under it). So this bucket is bounded, not resolved, and`);
      console.log(`  the bottom line below reports a range.`);
    }
    if (pin.rows.size) {
      console.log();
      if (pinDrifted.length) {
        console.log(`  replay pin: ${pinDrifted.length} of ${pinAgreed.length + pinDrifted.length} findings DRIFTED from the`);
        console.log(`  committed verdicts (drain/sessionEnd/facts) — re-pin before quoting a number:`);
        for (const d of pinDrifted) console.log(`    ${d.key}: pinned ${d.pinned}, replayed ${d.verdict}`);
      } else {
        console.log(
          `  replay pin: ${pinAgreed.length}/${pin.rows.size} committed rows reproduced (drain outcome,`
        );
        console.log(`  SessionEnd verdict and fact count — the denominator as well as the loss).`);
      }
    }
    console.log();
    console.log(`## For what it could not reach, does the SessionEnd distiller back it up?`);
    console.log(`  uncovered findings ........... ${uncovered.length}   [${uncoveredFacts} facts]`);
  } else {
    console.log(`## Does the SessionEnd distiller back it up?`);
    console.log(`  lost findings ................ ${stats.lost}   [${stats.lostFacts} facts]`);
  }
  console.log(
    `  ...whose session ran it ...... ${backstopRanFindings}  ${pct(backstopRanFindings, uncovered.length)}  (findings)`
  );
  console.log(
    `  ...and it extracted facts .... ${backstopProductiveFindings}  ${pct(
      backstopProductiveFindings,
      uncovered.length
    )}  (findings)`
  );
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
  if (modelSessionEndDrain) {
    console.log(
      `  surfaced at SessionEnd ....... ${sessionEnd.capturedFacts}  ${pct(
        sessionEnd.capturedFacts,
        stats.lostFacts
      )}  (verbatim — no coverage inference needed)`
    );
    console.log(`  left to the distiller ........ ${uncoveredFacts}`);
  }
  console.log(
    `  no distiller extraction ...... ${noBackstopFacts}  (no distiller output exists for these`
  );
  console.log(`                                    sessions — for an unobserved firing that is the`);
  console.log(`                                    SAME missing row, not a second opinion)`);
  console.log(`  distiller missed the fact .... ${adjMissing ? "?" : adjLost}`);
  if (!adjMissing) {
    console.log(
      `  DURABLY LOST ................. ${durablyLostLower}${
        durablyLostUpper === durablyLostLower ? "" : `–${durablyLostUpper}`
      }  ${pct(durablyLostLower, stats.factsTotal)}${
        durablyLostUpper === durablyLostLower ? "" : `–${pct(durablyLostUpper, stats.factsTotal)}`
      } of all classified facts`
    );
    console.log(
      `    demonstrated ............... ${durablyLostLower}  (the drain provably ran and did not capture it)`
    );
    console.log(
      `    indeterminate .............. ${indeterminateFacts}  (${sessionEnd.unobservedFacts} no SessionEnd observed, ${sessionEnd.unresolvedFacts} drain`
    );
    console.log(`                                    time unresolved — lost only if the hook never`);
    console.log(`                                    fired, or fired before the result landed)`);
    if (durablyLostUpper !== durablyLostLower) {
      console.log(`  Quote the RANGE. The upper end alone asserts an absence the journal cannot`);
      console.log(`  demonstrate; the lower end alone assumes away a loss it cannot rule out.`);
    }
  } else {
    console.log(`  DURABLY LOST ................. ?  (census is stale — see above)`);
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
  sessionEndDrains,
  distillLogDrains,
  sessionEndOutcome,
  asyncEndShift,
  asyncShiftBefore,
  promptDrains,
  splitFacts,
  stem,
};
