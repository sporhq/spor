"use strict";
// The measurement behind art-spor-async-nudge-session-final-loss-2026-07-17 is
// only as good as its two classifiers: which transcript entries are real prompt
// submissions (the drain oracle), and which classifier calls would have produced
// a spooled result at all. Both are easy to get quietly wrong — `type: user`
// covers tool_result echoes and injected meta as well as prompts, and they
// outnumber real prompts ~40:1, so a sloppy predicate would swamp the loss rate
// with phantom drains. These pin the two decisions.

const { test } = require("node:test");
const assert = require("node:assert");
const {
  verdictFacts,
  isPromptEntry,
  coverage,
  splitFacts,
  stem,
  sessionEndDrains,
  distillLogDrains,
  sessionEndOutcome,
  asyncEndShift,
  asyncShiftBefore,
  promptDrains,
} = require("../scripts/analysis/measure-async-nudge-loss.js");

const user = (extra) => ({ type: "user", message: { content: "do the thing" }, ...extra });

test("isPromptEntry: a promptSource-tagged submission is a drain opportunity", () => {
  for (const src of ["typed", "sdk", "system", "queued", "suggestion_accepted"]) {
    assert.equal(isPromptEntry(user({ promptSource: src }), false), true, src);
  }
});

test("isPromptEntry: a tool_result echo is never a prompt", () => {
  const entry = {
    type: "user",
    message: { content: [{ type: "tool_result", content: "ok" }] },
  };
  assert.equal(isPromptEntry(entry, false), false);
  // Even if some future writer tags one, the content shape wins: a tool result
  // fed back into the loop does not fire UserPromptSubmit.
  assert.equal(isPromptEntry({ ...entry, promptSource: "typed" }, false), false);
});

test("isPromptEntry: injected meta (skill bodies, command expansions) is not a prompt", () => {
  assert.equal(isPromptEntry(user({ isMeta: true }), false), false);
});

test("isPromptEntry: a subagent turn does not drain the parent session", () => {
  assert.equal(isPromptEntry(user({ promptSource: "sdk", isSidechain: true }), false), false);
});

test("isPromptEntry: untagged plain text still counts (older transcripts predate promptSource)", () => {
  assert.equal(isPromptEntry(user({}), false), true);
});

test("isPromptEntry: untagged harness echoes are not prompts", () => {
  // These carry neither promptSource nor isMeta, so only their shape separates
  // them from a submission. Each one accepted is a phantom drain hiding a loss.
  for (const echo of [
    "<local-command-stdout>on branch main</local-command-stdout>",
    "<local-command-stderr>fatal: no such ref</local-command-stderr>",
    "<bash-stdout>total 0</bash-stdout>",
    "<bash-input>ls -la</bash-input>",
  ]) {
    assert.equal(isPromptEntry({ type: "user", message: { content: echo } }, false), false, echo);
  }
  // ...but a real prompt that merely mentions one is still a prompt.
  assert.equal(
    isPromptEntry({ type: "user", message: { content: "why did <bash-stdout> look empty?" } }, false),
    true
  );
});

test("isPromptEntry: a slash command IS a prompt — it drains before the / gate", () => {
  // drainPendingNudges runs ahead of computeDigest's prompt.startsWith("/")
  // gate, so /clear drains the spool even though it produces no digest.
  // Excluding these would score genuine drains as losses.
  assert.equal(
    isPromptEntry({ type: "user", message: { content: "<command-name>/spor:defer</command-name>" } }, false),
    true
  );
});

test("isPromptEntry: a tagged submission counts whatever its content shape", () => {
  // An image-only paste fires the hook and drains; only the untagged path may
  // lean on content shape.
  const imageOnly = {
    type: "user",
    promptSource: "typed",
    message: { content: [{ type: "image", source: {} }] },
  };
  assert.equal(isPromptEntry(imageOnly, false), true);
  assert.equal(isPromptEntry(imageOnly, true), true);
});

test("isPromptEntry: strict mode counts only human-typed prompts", () => {
  assert.equal(isPromptEntry(user({ promptSource: "typed" }), true), true);
  assert.equal(isPromptEntry(user({ promptSource: "sdk" }), true), false);
  assert.equal(isPromptEntry(user({}), true), false);
});

test("verdictFacts: a backend failure yields no result to lose", () => {
  assert.equal(verdictFacts({ error: "nudge cmd failed", response: "" }), null);
});

test("verdictFacts: NOTHING spools no result", () => {
  assert.deepEqual(verdictFacts({ response: "NOTHING" }), { nfacts: 0, facts: "" });
});

test("verdictFacts: fact blocks are counted with the production parser", () => {
  const v = verdictFacts({
    response: "===FACT===\nThe cache never invalidates on rename.\n===END===\n===FACT===\nA second fact.\n===END===",
  });
  assert.equal(v.nfacts, 2);
  assert.match(v.facts, /cache never invalidates/);
});

test("splitFacts: the numbered list splits per fact, not per finding", () => {
  assert.deepEqual(splitFacts("1. first fact here\n2. second fact here\n"), [
    "first fact here",
    "second fact here",
  ]);
  assert.deepEqual(splitFacts(""), []);
});

test("coverage: inflection alone must not score a real capture as a miss", () => {
  // The distiller restates facts in its own words; `rejects`/`reject` and
  // `placeholders`/`placeholder` are the same claim.
  const fact = "The validator rejects unfilled template placeholders.";
  const distill = "Validation was introduced to reject submissions containing only template placeholder variables.";
  assert.ok(coverage(fact, distill) >= 0.6, `expected stemmed overlap, got ${coverage(fact, distill)}`);
});

test("stem: plurals meet their singular (this codebase's own vocabulary)", () => {
  // Two orderings get the -ches/-shes/-xes words right and disagree only on the
  // -se class, so a table drawn from the safe classes passes over a broken
  // stemmer. `case`/`cases` and `response`/`responses` are the ones that bite:
  // an -es rule ahead of the plural strip gives cases->ca vs case->cas.
  for (const [a, b] of [
    // the -se class — the ordering canary
    ["cases", "case"],
    ["uses", "use"],
    ["responses", "response"],
    ["releases", "release"],
    ["phases", "phase"],
    ["parses", "parse"],
    ["databases", "database"],
    // the classes that survive either ordering
    ["caches", "cache"],
    ["matches", "match"],
    ["hashes", "hash"],
    ["classes", "class"],
    ["indexes", "index"],
    ["edges", "edge"],
    ["rejects", "reject"],
    ["placeholders", "placeholder"],
    ["queries", "query"],
  ]) {
    assert.equal(stem(a), stem(b), `${a} vs ${b}`);
  }
  // ...without collapsing genuinely different words into one stem.
  assert.notEqual(stem("session"), stem("schema"));
  assert.notEqual(stem("prompt"), stem("project"));
});

test("coverage: two sentences stating the same fact score alike despite inflection", () => {
  // The regression the stemmer ordering caused: 0.6 instead of 1.0 on an
  // identical claim, silently deflating the lexical bound.
  const a = "The prefix cases are handled by the response parser.";
  const b = "Each prefix case is handled by the responses parser.";
  assert.equal(coverage(a, b), 1);
});

test("coverage: an unrelated distiller extraction scores near zero", () => {
  const fact = "Inbound resolves edges are authoritative over the status field.";
  const distill = "The marketing site footer grid expanded from three columns to four.";
  assert.ok(coverage(fact, distill) < 0.2);
});

// The second run (task-spor-reevaluate-nudge-async-default-post-sessionend)
// re-scores the same replay against the SHIPPED client, where
// sessionEndPendingNudges drains the leftover spool at SessionEnd. That verdict
// turns on a timing comparison between two clocks — the synchronous timeline the
// journal recorded, and the async one it is being corrected onto — and getting
// the correction backwards would silently convert every race into a clean
// capture. These pin it.

test("sessionEndDrains: the drain time is the distill row minus its own latency", () => {
  // sessionEndPendingNudges runs at the TOP of distill(), before the backend
  // call the row is stamped after — so the row's ts overstates the drain by the
  // whole backend latency, and using it raw would credit a capture to a session
  // that ended before the worker answered.
  assert.deepEqual(
    sessionEndDrains([{ ts: "2026-08-10T10:00:30.000Z", latency_ms: 30000 }]),
    [Date.parse("2026-08-10T10:00:00.000Z")]
  );
});

test("sessionEndDrains: unusable rows degrade to the row's own timestamp, ascending", () => {
  // A missing/zero/garbled latency must not shift the drain the wrong way (a
  // negative correction would invent slack that never existed).
  const drains = sessionEndDrains([
    { ts: "2026-08-10T11:00:00.000Z", latency_ms: 0 },
    { ts: "2026-08-10T10:00:00.000Z", latency_ms: -5 },
    { ts: "2026-08-10T09:00:00.000Z" },
    { ts: "not a timestamp", latency_ms: 100 },
  ]);
  assert.deepEqual(drains, [
    Date.parse("2026-08-10T09:00:00.000Z"),
    Date.parse("2026-08-10T10:00:00.000Z"),
    Date.parse("2026-08-10T11:00:00.000Z"),
  ]);
});

test("asyncEndShift: async gives back this call's blocking plus every later one", () => {
  // Blocks BEFORE the call shift its result file and the session end by the
  // same amount and cancel out; blocks at or after it do not.
  const call = { ts: "2026-08-10T10:00:10.000Z", latency_ms: 5000 };
  const session = [
    { ts: "2026-08-10T09:59:00.000Z", latency_ms: 9000 }, // earlier: cancels
    call,
    { ts: "2026-08-10T10:02:00.000Z", latency_ms: 4000 },
    { ts: "2026-08-10T10:03:00.000Z", latency_ms: 3000 },
  ];
  assert.equal(asyncEndShift(call, session), 12000);
  assert.equal(asyncEndShift(call, [call]), 5000);
  assert.equal(asyncEndShift(call, undefined), 0);
});

test("asyncShiftBefore: a moment mid-session gets back only the blocking that preceded IT", () => {
  // The prompt drain needs this: a prompt between two later classifier calls
  // was moved earlier by the calls before it, not by the ones after it. Summing
  // the whole tail there would over-correct and score a real drain as a loss.
  const call = { ts: "2026-08-10T10:00:10.000Z", latency_ms: 5000 };
  const session = [
    { ts: "2026-08-10T09:59:00.000Z", latency_ms: 9000 }, // earlier: cancels
    call,
    { ts: "2026-08-10T10:02:00.000Z", latency_ms: 4000 },
    { ts: "2026-08-10T10:03:00.000Z", latency_ms: 3000 },
  ];
  assert.equal(asyncShiftBefore(call, session, Date.parse("2026-08-10T10:01:00Z")), 5000);
  assert.equal(asyncShiftBefore(call, session, Date.parse("2026-08-10T10:02:30Z")), 9000);
  assert.equal(asyncShiftBefore(call, session, Infinity), 12000);
  // The default is the whole tail, which is what the SessionEnd comparison wants.
  assert.equal(asyncShiftBefore(call, session), asyncEndShift(call, session));
});

test("promptDrains: a prompt is judged on the async clock, not the synchronous one", () => {
  // The defect this pins: `promptAt > resultAt` reads a prompt 2s after a
  // classifier that blocked for 5s as a clean drain, when under async that
  // prompt happens 3s BEFORE the worker's result exists. Both events move, and
  // they do not move together.
  const resultAt = Date.parse("2026-08-10T10:00:00Z");
  assert.equal(promptDrains({ resultAt, promptAt: resultAt + 2000, shiftMs: 5000 }), false);
  assert.equal(promptDrains({ resultAt, promptAt: resultAt + 8000, shiftMs: 5000 }), true);
  // A tie is not a drain, same boundary rule as sessionEndOutcome.
  assert.equal(promptDrains({ resultAt, promptAt: resultAt + 5000, shiftMs: 5000 }), false);
  // With nothing blocking, it degrades to the naive comparison.
  assert.equal(promptDrains({ resultAt, promptAt: resultAt + 1, shiftMs: 0 }), true);
  // A prompt BEFORE the call is never a drain, whatever the shift.
  assert.equal(promptDrains({ resultAt, promptAt: resultAt - 1000, shiftMs: 0 }), false);
});

test("asyncEndShift: an errored or NOTHING call still blocked the tool loop", () => {
  // It produces no result file, but the synchronous path waited for it, so the
  // time it returns is real. Dropping these would understate the shift.
  const call = { ts: "2026-08-10T10:00:00.000Z", latency_ms: 1000 };
  assert.equal(
    asyncEndShift(call, [call, { ts: "2026-08-10T10:01:00.000Z", latency_ms: 8000, error: "nudge cmd failed" }]),
    9000
  );
});

test("sessionEndOutcome: an unobserved SessionEnd is indeterminate, not a demonstrated loss", () => {
  // The verdict name is the contract. Both observables (the distiller's
  // llm-calls row and its distill.log line) sit BELOW the drain in distill(),
  // so their absence cannot distinguish "the hook never fired" (a real loss)
  // from "the firing was suppressed after the drain" (a verbatim capture) —
  // the residual is a bound, and calling this `no-sessionend` read as a
  // measured cause.
  const r = sessionEndOutcome({ resultAt: Date.parse("2026-08-10T10:00:00Z"), shiftMs: 5000 }, []);
  assert.deepEqual(r, { verdict: "no-sessionend-observed", marginMs: null });
});

test("distillLogDrains: a distill.log line is a SessionEnd firing the llm-calls journal missed", () => {
  // The too-small-transcript exit returns before any backend call, so it
  // records no llm-calls row — but it logs, and it logs BELOW the drain. Without
  // this reader such a session reads as "never fired" and is charged to the
  // residual.
  const log = [
    "[2026-08-10T10:00:00+00:00] sess-a: skipped: transcript too small",
    "[2026-08-10T11:00:00+00:00] sess-b: distill cmd failed",
    "  wrote /graph/nodes/dec-x.md (session-final nudge capture)", // continuation: unprefixed
    "[2026-08-10T09:00:00+00:00] sess-a: distilled 2 nodes",
    "not a log line at all",
    "[garbled] sess-a: whatever",
  ].join("\n");
  assert.deepEqual(distillLogDrains(log, "sess-a"), [
    Date.parse("2026-08-10T09:00:00Z"),
    Date.parse("2026-08-10T10:00:00Z"),
  ]);
  assert.deepEqual(distillLogDrains(log, "sess-c"), []);
  assert.deepEqual(distillLogDrains("", "sess-a"), []);
  assert.deepEqual(distillLogDrains(log, ""), []);
});

test("sessionEndOutcome: the session must outlive the tool-loop time async gives back", () => {
  const at = Date.parse("2026-08-10T10:00:00Z");
  const drain = (s) => [at + s * 1000];
  // 10s of remaining wall-clock against a 5s shift: the worker's result is on
  // disk when the drain runs.
  assert.equal(sessionEndOutcome({ resultAt: at, shiftMs: 5000 }, drain(10)).verdict, "captured");
  // 3s against the same 5s shift: async reached SessionEnd first — the race the
  // one-turn delay can still lose.
  assert.equal(sessionEndOutcome({ resultAt: at, shiftMs: 5000 }, drain(3)).verdict, "too-late");
  // Exactly on the boundary is NOT a capture: a tie means the drain and the
  // write are simultaneous, and the drain reads the directory first.
  assert.equal(sessionEndOutcome({ resultAt: at, shiftMs: 5000 }, drain(5)).verdict, "too-late");
});

test("sessionEndOutcome: a later SessionEnd still drains what an earlier one missed", () => {
  // A resumed session ends more than once, and an undrained .out.json persists
  // until some SessionEnd consumes it — so the BEST firing decides, and the
  // margin reported is that firing's.
  const at = Date.parse("2026-08-10T10:00:00Z");
  const r = sessionEndOutcome({ resultAt: at, shiftMs: 5000 }, [at - 60000, at + 2000, at + 600000]);
  assert.equal(r.verdict, "captured");
  assert.equal(r.marginMs, 595000);
});

test("the committed replay pin is internally consistent", () => {
  // The pin is what survives once ~/.claude/projects prunes the transcripts the
  // verdicts were derived from, so a headline that has drifted from its own
  // per-finding rows would be unfalsifiable afterwards.
  const pin = require("../scripts/analysis/sessionend-replay-2026-09-04.json");
  const h = pin.headline;
  const lost = pin.findings.filter((f) => f.drain === "lost");
  assert.equal(lost.length, h.lost);
  const tally = (v) => lost.filter((f) => f.verdict === v);
  assert.equal(tally("captured").length, h.capturedAtSessionEnd);
  assert.equal(tally("too-late").length, h.tooLate);
  assert.equal(tally("no-sessionend-observed").length, h.noSessionEndObserved);
  const facts = (rows) => rows.reduce((n, f) => n + f.nfacts, 0);
  assert.equal(facts(tally("captured")), h.capturedFacts);
  assert.equal(facts(tally("no-sessionend-observed")), h.noSessionEndObservedFacts);
  assert.equal(facts(lost), h.lostFacts);
  // The residual is a RANGE, and both ends must fall out of the rows: the lower
  // end counts only what the drain demonstrably ran on and missed, the upper end
  // additionally charges every unobserved firing. Quoting the upper end as a
  // measured loss rate is the claim this pin exists to keep falsifiable.
  assert.equal(h.lostFacts - h.capturedFacts, h.durablyLostFactsUpper);
  assert.equal(h.durablyLostFactsUpper - h.noSessionEndObservedFacts, h.durablyLostFactsLower);
  // THE DENOMINATOR, derived — not asserted. A pin holding only the numerator
  // cannot be audited after the transcripts are pruned: `findingsScored`,
  // `drained` and `factsTotal` would have no rows behind them, and the 7.2%
  // upper bound they divide into would be unfalsifiable.
  assert.equal(pin.findings.length, h.findingsScored);
  assert.equal(pin.findings.filter((f) => f.drain === "drained").length, h.drained);
  assert.equal(h.drained + h.lost, h.findingsScored);
  assert.equal(facts(pin.findings), h.factsTotal);
  // A drained row carries no SessionEnd verdict: the drain never had to run.
  for (const f of pin.findings.filter((f) => f.drain === "drained")) assert.equal(f.verdict, null);
  for (const f of lost) assert.ok(f.verdict, `lost row ${f.key} has no verdict`);
  // Every key must be distinct, or a re-run's drift check silently compares a
  // finding against another finding's verdict.
  assert.equal(new Set(pin.findings.map((f) => f.key)).size, pin.findings.length);
});
