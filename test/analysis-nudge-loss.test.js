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

test("isPromptEntry: untagged injected wrappers are not prompts", () => {
  // These carry neither promptSource nor isMeta, so only their shape separates
  // them from a submission — 354 of the 521 untagged entries in the real corpus.
  // Each one accepted here is a phantom drain that hides a real loss.
  for (const wrapper of [
    "<local-command-stdout>on branch main</local-command-stdout>",
    "<command-name>/code-review</command-name>",
    "<command-message>review is running</command-message>",
  ]) {
    assert.equal(isPromptEntry({ type: "user", message: { content: wrapper } }, false), false, wrapper);
  }
  // ...but a real prompt that merely mentions one is still a prompt.
  assert.equal(
    isPromptEntry({ type: "user", message: { content: "why did <command-name> fail?" } }, false),
    true
  );
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

test("stem: -es plurals meet their singular (this codebase's own vocabulary)", () => {
  // A suffix rule that strips the whole `ches`/`shes`/`xes` run yields
  // caches->ca vs cache->cache: the exact inflection miss stemming exists to
  // prevent, over the words this graph talks about most.
  for (const [a, b] of [
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
});

test("coverage: an unrelated distiller extraction scores near zero", () => {
  const fact = "Inbound resolves edges are authoritative over the status field.";
  const distill = "The marketing site footer grid expanded from three columns to four.";
  assert.ok(coverage(fact, distill) < 0.2);
});
