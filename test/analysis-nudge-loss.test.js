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
