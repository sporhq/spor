// A reviewer OUTAGE that names its own end
// (task-spor-review-gate-quota-outage-reset-aware-pause-and-fallback-reviewer,
// dec-spor-reviewer-reset-pause-budget-and-provenance).
//
// On 2026-09-05 Codex answered every review with "You've hit your usage limit
// … try again at Sep 7th, 2026 6:27 AM". The no-verdict fix stopped charging
// fix cycles, but its remedy was a fixed backoff that re-asked a backend whose
// end was known and ~44h away, spent the pool, and paged a person. Four
// oracles here:
//
//   1. the READING — the reset phrase is lifted from the harness's terminal
//      line, read only in a captured host offset, and carried on the
//      classification as `reset_at`;
//   2. the PAUSE — a stated reset parks the pipeline (`interrupted` +
//      `paused_until`, slot freed) instead of waiting in-process, costs no fix
//      cycle, no rescue and no pool charge of its own, is honored by a resume
//      that did not create it, and is bounded by the gate's pause cap;
//   3. the COOLDOWN — every other item this box judges pauses on the lane's
//      stamp instead of dispatching into the same dead backend, and the stamp
//      is reconciled (a passed reset, a strictly newer success) every read;
//   4. the FALLBACK — a declared second lane is routed to only on a
//      no-verdict reading, only when its model family differs from the
//      implementer's, is charged to the shared pool, keeps judging after a
//      fix cycle, and every verdict it gives names it.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");

const gates = require("../lib/kernel/gates.js");
const gateRunner = require("../lib/shell/gate-runner.js");
const workLoop = require("../lib/shell/work-loop.js");
const runner = require("../lib/shell/agent-dispatch-runner.js");
const attestation = require("../lib/shell/attestation.js");

const CODEX_LINE = JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 7th, 2026 6:27 AM." } });
const HOUR = 3600000;

// ------------------------------------------------------------- the reading --

test("the Codex usage-limit line classifies as an environment outage WITH its reset hint", () => {
  const known = runner.classifyTerminalText(CODEX_LINE);
  assert.strictEqual(known.class, "environment");
  assert.strictEqual(known.signal, "usage-limit");
  assert.deepStrictEqual(known.reset_hint, { kind: "absolute", text: "Sep 7th, 2026 6:27 AM" });
  const fields = runner.resetHintFields(known, Date.parse("2026-09-05T10:00:00Z"));
  assert.deepStrictEqual(fields.termination_reset_hint, known.reset_hint);
  assert.strictEqual(typeof fields.termination_utc_offset_min, "number", "the originating host's offset rides beside the hint");
  assert.ok(!Object.is(fields.termination_utc_offset_min, -0));
  // A non-environment ending never carries one, and neither does a line with none.
  assert.deepStrictEqual(runner.resetHintFields(runner.classifyTerminalText('{"type":"error","message":"rate_limit_error"}')), {});
});

test("an absolute reset is read ONLY in a captured offset — never a guessed zone", () => {
  const hint = gates.findResetHint(CODEX_LINE);
  const anchorMs = Date.parse("2026-09-05T10:00:00Z");
  assert.strictEqual(gates.resetInstant(hint, { anchorMs }), null, "no offset: the unknown-reset reading");
  assert.strictEqual(new Date(gates.resetInstant(hint, { anchorMs, utcOffsetMin: 0 })).toISOString(), "2026-09-07T06:27:00.000Z");
  assert.strictEqual(new Date(gates.resetInstant(hint, { anchorMs, utcOffsetMin: -420 })).toISOString(), "2026-09-07T13:27:00.000Z", "PDT wall clock → UTC");
  assert.strictEqual(new Date(gates.resetInstant(hint, { anchorMs, utcOffsetMin: 120 })).toISOString(), "2026-09-07T04:27:00.000Z");
  // An impossible date is refused, not rolled into the next month.
  assert.strictEqual(gates.resetInstant({ kind: "absolute", text: "Feb 31st, 2027 1:00 PM" }, { anchorMs, utcOffsetMin: 0 }), null);
  // No year: the next occurrence after the anchor.
  assert.strictEqual(new Date(gates.resetInstant({ kind: "absolute", text: "Jan 2nd 3:00 AM" }, { anchorMs: Date.parse("2026-12-30T12:00:00Z"), utcOffsetMin: 0 })).toISOString(), "2027-01-02T03:00:00.000Z");
  // Outside [anchor − 10min, anchor + 30d] is not a reset anyone should park on.
  assert.strictEqual(gates.resetInstant({ kind: "absolute", text: "Sep 1st, 2026 1:00 AM" }, { anchorMs, utcOffsetMin: 0 }), null);
  assert.strictEqual(gates.resetInstant({ kind: "absolute", text: "Dec 1st, 2026 1:00 AM" }, { anchorMs, utcOffsetMin: 0 }), null);
});

test("relative and Retry-After hints count from the run's end, offset or not", () => {
  const anchorMs = Date.parse("2026-09-05T10:00:00Z");
  const rel = gates.findResetHint("Rate limit reached. Please try again in 4 days 3 hours 5 minutes.");
  assert.deepStrictEqual(rel, { kind: "relative", text: "4 days 3 hours 5 minutes" });
  assert.strictEqual(new Date(gates.resetInstant(rel, { anchorMs })).toISOString(), "2026-09-09T13:05:00.000Z");
  const sec = gates.findResetHint('HTTP 429 {"retry-after": "120"}');
  assert.deepStrictEqual(sec, { kind: "seconds", text: "120" });
  assert.strictEqual(gates.resetInstant(sec, { anchorMs }), anchorMs + 120000);
  assert.strictEqual(gates.findResetHint("the suite failed; try again later"), null);
});

test("the classifier carries `reset_at` on an infrastructure reading only when the record states one", () => {
  const base = { state: "failed", termination_class: "environment", termination_signal: "usage-limit", finished_at: "2026-09-05T10:00:00Z" };
  const withHint = gates.classifyExecutionOutcome({ ...base, termination_reset_hint: { kind: "absolute", text: "Sep 7th, 2026 6:27 AM" }, termination_utc_offset_min: 0 });
  assert.strictEqual(withHint.outcome, "infrastructure");
  assert.strictEqual(withHint.reset_at, Date.parse("2026-09-07T06:27:00Z"));
  // A record from before the stamp, or with no offset: exactly the old reading.
  assert.deepStrictEqual(gates.classifyExecutionOutcome(base), { outcome: "infrastructure", pool: "retry", reason: "the harness ended on an environment failure (usage-limit)" });
  assert.strictEqual(gates.classifyExecutionOutcome({ ...base, termination_reset_hint: { kind: "absolute", text: "Sep 7th, 2026 6:27 AM" } }).reset_at, undefined);
});

// ------------------------------------------------------------ the parse --

function factoryOf(payload) {
  const body = ["```json", JSON.stringify(payload), "```"].join("\n");
  return gates.parseFactory(body, { id: "factory-test" });
}

const BASE = { factory: "test", trusted_ref: "main", protected_paths: ["test/**"], test_lane_profile: "profile-test-writer" };

test("fallback_profile / fallback_after / pause_max_ms parse onto an agent-review gate only when declared", () => {
  const plain = factoryOf({ ...BASE, gates: [{ id: "review", kind: "agent-review", profile: "profile-review" }] });
  assert.deepStrictEqual(plain.errors, []);
  for (const k of ["fallbackProfile", "fallbackAfter", "pauseMaxMs"]) {
    assert.ok(!(k in plain.factory.gates[0]), `${k} is not written onto a gate that did not declare it — the definition digest stays what it was`);
  }
  const fb = factoryOf({ ...BASE, gates: [{ id: "review", kind: "agent-review", profile: "profile-review", fallback_profile: "profile-claude-review", fallback_after: 2, pause_max_ms: 3600000 }] });
  assert.deepStrictEqual(fb.errors, []);
  assert.strictEqual(fb.factory.gates[0].fallbackProfile, "profile-claude-review");
  assert.strictEqual(fb.factory.gates[0].fallbackAfter, 2);
  assert.strictEqual(fb.factory.gates[0].pauseMaxMs, 3600000);
  const self = factoryOf({ ...BASE, gates: [{ id: "review", kind: "agent-review", profile: "profile-review", fallback_profile: "profile-review" }] });
  assert.match(self.errors.join("; "), /a fallback must be a different review lane/);
  const orphan = factoryOf({ ...BASE, gates: [{ id: "review", kind: "agent-review", profile: "profile-review", fallback_after: 2 }] });
  assert.match(orphan.errors.join("; "), /fallback_after is set but no fallback_profile/);
});

test("model families compare canonically", () => {
  assert.strictEqual(gates.canonicalModelFamily(" GPT_5 "), "gpt-5");
  assert.strictEqual(gates.canonicalModelFamily("gpt-5"), gates.canonicalModelFamily("GPT 5"));
  assert.strictEqual(gates.canonicalModelFamily(""), null);
  assert.strictEqual(gates.canonicalModelFamily(undefined), null);
});

// ------------------------------------------------------------ the cooldown --

test("a cooldown stamp holds only until its reset, and only against a strictly NEWER success", () => {
  const stamp = { until: 1000, at: 500, reason: "usage limit" };
  assert.strictEqual(gates.reviewerCooldownActive(stamp, { now: 600 }), stamp);
  assert.strictEqual(gates.reviewerCooldownActive(stamp, { now: 1000 }), null, "a passed reset never blocks a review");
  assert.strictEqual(gates.reviewerCooldownActive(stamp, { now: 600, successAt: 400 }), stamp, "a STALE success does not clear a newer outage");
  assert.strictEqual(gates.reviewerCooldownActive(stamp, { now: 600, successAt: 500 }), stamp, "a success at the same instant proves nothing newer");
  assert.strictEqual(gates.reviewerCooldownActive(stamp, { now: 600, successAt: 501 }), null, "a newer success clears it");
  // The newer observation wins a merge; a late, older one changes nothing.
  const newer = { until: 2000, at: 700 };
  assert.strictEqual(gates.mergeReviewerCooldown(stamp, newer), newer);
  assert.strictEqual(gates.mergeReviewerCooldown(newer, stamp), newer);
});

// ------------------------------------------------------------ the pipeline --

const T0 = Date.parse("2026-09-05T10:00:00Z");
const RESET = T0 + 44 * HOUR;
const ITEM = { node_id: "task-demo", run_id: "run-abcdef12", project: "demo" };

function outage({ resetAt = RESET, runId = "rev-1" } = {}) {
  const reason = "the harness ended on an environment failure (usage-limit)";
  return { ok: false, reason, runId, finishedAt: new Date(T0).toISOString(), classification: { outcome: "infrastructure", pool: "retry", reason, ...(resetAt ? { reset_at: resetAt } : {}) } };
}
const PASS = { ok: true, text: '```json\n{"verdict":"pass"}\n```', finishedAt: new Date(T0 + 1000).toISOString() };

function reviewFactory(gate = {}, retry = { attempts: 2, backoff_ms: 60000 }) {
  const r = factoryOf({
    ...BASE,
    ...(retry ? { implementation: { profile: "profile-impl", retry } } : {}),
    rescue: { profile: "profile-rescue" },
    gates: [{ id: "review", kind: "agent-review", profile: "profile-codex-review", cycles: 2, ...gate }],
  });
  assert.deepStrictEqual(r.errors, []);
  return r.factory;
}

// A fake world with a MERGING pool store (the shell's saveGatePools merges per
// pool name) and an in-memory cooldown store shared across pipelines.
function world({ review, pools = { retry: { spent: 0 } }, cooldowns = new Map(), independence = () => ({ ok: true, family: "claude" }), clock = T0 } = {}) {
  const seen = { reviews: [], fixes: [], facts: [], escalations: [], rescues: 0, pools: JSON.parse(JSON.stringify(pools)), stamps: [], successes: [] };
  let now = clock;
  const deps = {
    now: () => now,
    sleep: async (ms) => { now += ms; },
    changedPaths: async () => ({ ok: true, paths: ["lib/x.js"], head: "h".repeat(40), base: "b".repeat(40), trustedRef: "main", trustedSha: "t".repeat(40), branch: "task-demo" }),
    review: async (args) => {
      seen.reviews.push({ profile: args.gate.profile, cycle: args.cycle });
      return review(args, seen);
    },
    fix: async (args) => { seen.fixes.push(args.cycle); return { ok: true }; },
    recordFact: async ({ id, markdown }) => { seen.facts.push({ id, markdown }); return { ok: true, id }; },
    escalate: async (args) => { seen.escalations.push(args); return { ok: true, id: "task-gate-review" }; },
    demote: async () => ({ ok: true, demoted: true }),
    rescue: async () => { seen.rescues += 1; throw new Error("an outage is never rescued"); },
    loadGatePools: async () => JSON.parse(JSON.stringify(seen.pools)),
    saveGatePools: async ({ pools: next }) => {
      for (const [name, pool] of Object.entries(next)) seen.pools[name] = { ...(seen.pools[name] || {}), ...pool };
    },
    reviewerCooldown: async ({ profile, now: at }) => {
      const s = cooldowns.get(profile);
      return s ? gates.reviewerCooldownActive(s, { now: at, successAt: s.success_at || 0 }) : null;
    },
    stampReviewerCooldown: async (stamp) => {
      seen.stamps.push(stamp);
      const prev = cooldowns.get(stamp.profile);
      cooldowns.set(stamp.profile, { ...gates.mergeReviewerCooldown(prev, stamp), ...(prev && prev.success_at ? { success_at: prev.success_at } : {}) });
    },
    noteReviewerSuccess: async ({ profile, at }) => {
      seen.successes.push({ profile, at });
      const prev = cooldowns.get(profile);
      if (prev && !(prev.success_at >= at)) cooldowns.set(profile, { ...prev, success_at: at });
    },
    reviewerIndependence: async (args) => independence(args),
  };
  return { deps, seen, cooldowns, advance: (ms) => { now += ms; }, at: () => now };
}

test("a usage-limit outage with a stated reset PARKS the pipeline: slot freed, nothing settled, no cycle, no rescue", async () => {
  const factory = reviewFactory();
  const w = world({ review: () => outage() });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: w.deps });
  assert.strictEqual(res.state, "interrupted", "a pause settles nothing");
  assert.strictEqual(res.paused_until, RESET, "it says until when");
  assert.strictEqual(res.paused_profile, "profile-codex-review");
  assert.strictEqual(w.seen.reviews.length, 1, "no re-ask of a backend whose end is known");
  assert.strictEqual(w.seen.fixes.length, 0, "no fix cycle is charged");
  assert.strictEqual(w.seen.rescues, 0, "and no rescue");
  assert.strictEqual(w.seen.escalations.length, 0, "and nobody is paged");
  assert.strictEqual(w.seen.facts.length, 0, "an unsettled pause writes no fact");
  assert.strictEqual(w.seen.pools.retry.spent, 1, "the review AFTER the wake is charged now, owe-before-clear");
  assert.strictEqual(w.seen.pools.retry.paused_until, RESET);
  assert.deepStrictEqual(w.seen.stamps.map((s) => [s.profile, s.until, s.run_id]), [["profile-codex-review", RESET, "rev-1"]], "the lane's cooldown is stamped for every other item");
});

test("a resumed worker honors a pause it did not create — and the review after the wake takes the charge already paid", async () => {
  const factory = reviewFactory();
  // Still inside the pause: parked again at once, nothing dispatched or charged.
  const early = world({ review: () => { throw new Error("nothing may be dispatched inside a pause"); }, pools: { retry: { spent: 1, due_at: RESET, paused_until: RESET } }, clock: T0 + HOUR });
  const r1 = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: early.deps });
  assert.strictEqual(r1.state, "interrupted");
  assert.strictEqual(r1.paused_until, RESET);
  assert.strictEqual(early.seen.pools.retry.spent, 1, "a pause costs no retry capacity");
  // Past the wake: the review runs, and passes.
  const late = world({ review: () => PASS, pools: { retry: { spent: 1, due_at: RESET, paused_until: RESET } }, clock: RESET + 1000 });
  const r2 = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: late.deps });
  assert.strictEqual(r2.state, "passed");
  assert.strictEqual(late.seen.reviews.length, 1);
  assert.strictEqual(late.seen.pools.retry.spent, 1, "the post-wake review was the one already charged");
});

test("a reset past the gate's pause cap is refused naming the reset — a person, not a two-week park", async () => {
  const factory = reviewFactory({ pause_max_ms: 24 * HOUR });
  const w = world({ review: () => outage() });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: w.deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(w.seen.fixes.length, 0);
  assert.strictEqual(w.seen.rescues, 0);
  assert.match(w.seen.escalations[0].outage.notRetried, /past this gate's pause cap of 24h/);
  assert.strictEqual(w.seen.pools.retry.spent, 0, "nothing was charged for a review that will not happen");
});

test("a pool declared at zero authorizes no review after the wake: refused, naming the reset", async () => {
  const factory = reviewFactory({}, null);
  const w = world({ review: () => outage() });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: w.deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(w.seen.reviews.length, 1);
  assert.match(w.seen.escalations[0].outage.notRetried, /out until 2026-09-07T06:00:00.000Z.*no infrastructure retry pool/);
  assert.strictEqual(w.seen.stamps.length, 1, "the cooldown is still stamped, so the next item pauses instead of asking");
});

test("an outage with NO stated reset keeps the declared backoff exactly as before", async () => {
  const factory = reviewFactory({}, { attempts: 1, backoff_ms: 60000 });
  let n = 0;
  const w = world({ review: () => (++n === 1 ? outage({ resetAt: null }) : PASS) });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: w.deps });
  assert.strictEqual(res.state, "passed");
  assert.strictEqual(w.seen.reviews.length, 2);
  assert.strictEqual(w.seen.pools.retry.spent, 1);
  assert.strictEqual(w.seen.pools.retry.paused_until, undefined, "no pause is invented");
  assert.strictEqual(w.seen.stamps.length, 0, "and no cooldown without a stated end");
});

test("a lane already COOLING is not dispatched into: the item pauses for free, and reviews once the reset passes", async () => {
  const factory = reviewFactory({}, null);
  const cooldowns = new Map([["profile-codex-review", { until: RESET, at: T0 - 1000, reason: "usage limit", run_id: "other-item-run" }]]);
  const w = world({ review: () => { throw new Error("no dispatch into a cooling lane"); }, cooldowns });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: w.deps });
  assert.strictEqual(res.state, "interrupted", "paused, even with no pool — no dispatch was made, so nothing needs paying for");
  assert.strictEqual(res.paused_until, RESET);
  assert.strictEqual(w.seen.pools.retry.spent, 0, "the pause itself is free");
  assert.strictEqual(w.seen.escalations.length, 0, "no outage is filed per item");
  // After the reset the stamp blocks nothing and the review is the gate's first.
  const later = world({ review: () => PASS, cooldowns, pools: w.seen.pools, clock: RESET + 1 });
  const r2 = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: later.deps });
  assert.strictEqual(r2.state, "passed");
  assert.strictEqual(later.seen.reviews.length, 1);
});

test("a success under the lane NEWER than the outage clears the cooldown; an older one does not", async () => {
  const factory = reviewFactory({}, null);
  const stale = new Map([["profile-codex-review", { until: RESET, at: T0, success_at: T0 - 5000 }]]);
  const w1 = world({ review: () => PASS, cooldowns: stale });
  assert.strictEqual((await gateRunner.runGatePipeline({ item: ITEM, factory, deps: w1.deps })).state, "interrupted", "a stale success does not clear a newer outage");
  const cleared = new Map([["profile-codex-review", { until: RESET, at: T0, success_at: T0 + 5000 }]]);
  const w2 = world({ review: () => PASS, cooldowns: cleared, clock: T0 + 10000 });
  assert.strictEqual((await gateRunner.runGatePipeline({ item: ITEM, factory, deps: w2.deps })).state, "passed");
  assert.deepStrictEqual(w2.seen.successes.map((s) => s.profile), ["profile-codex-review"], "an answering review notes its success for the next reader");
});

test("a declared FALLBACK is routed to on a no-verdict reading, charged to the pool, and every verdict names it", async () => {
  const factory = reviewFactory({ fallback_profile: "profile-claude-review" });
  const w = world({
    review: (args) => (args.gate.profile === "profile-codex-review" ? outage() : PASS),
  });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: w.deps });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(w.seen.reviews.map((r) => r.profile), ["profile-codex-review", "profile-claude-review"]);
  assert.strictEqual(w.seen.pools.retry.spent, 1, "the fallback dispatch is charged to the shared pool");
  assert.deepStrictEqual(w.seen.pools.routes.review, { profile: "profile-claude-review", fallback_for: "profile-codex-review", after: 1, family: "claude" });
  assert.strictEqual(res.gates[0].reviewer.profile, "profile-claude-review", "the result names who judged");
  assert.match(w.seen.facts[0].markdown, /Reviewer: `profile-claude-review` — the declared fallback for `profile-codex-review`/);
  assert.strictEqual(w.seen.stamps.length, 1, "the primary is still stamped cooling for other items");
});

test("a fallback that asks for changes keeps judging after the fix — a cooling primary does not suppress it — and the blocking verdict names it", async () => {
  const factory = reviewFactory({ fallback_profile: "profile-claude-review" });
  let fallbackCalls = 0;
  const w = world({
    review: (args) => {
      if (args.gate.profile === "profile-codex-review") return outage();
      fallbackCalls += 1;
      return fallbackCalls === 1
        ? { ok: true, text: '```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"lib/x.js","summary":"off by one","evidence":"node -e ran and printed 3"}]}\n```' }
        : { ok: true, text: '```json\n{"verdict":"pass","prior":[{"id":"F1","status":"resolved","note":"re-ran it, prints 2"}],"findings":[]}\n```' };
    },
  });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: w.deps });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(w.seen.reviews.map((r) => [r.profile, r.cycle]), [["profile-codex-review", 0], ["profile-claude-review", 0], ["profile-claude-review", 1]]);
  assert.deepStrictEqual(w.seen.fixes, [0], "the fallback's finding is a real one, fixed on a cycle");
  assert.strictEqual(w.seen.pools.retry.spent, 1, "the second fallback review is an ordinary fix-cycle review, not another outage retry");

  // A fallback's BLOCKING refusal (cycles spent) still names the fallback.
  const strict = reviewFactory({ fallback_profile: "profile-claude-review", cycles: 0 });
  const w2 = world({
    review: (args) => (args.gate.profile === "profile-codex-review" ? outage() : { ok: true, text: '```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"lib/x.js","summary":"off by one","evidence":"ran it"}]}\n```' }),
  });
  const r2 = await gateRunner.runGatePipeline({ item: ITEM, factory: strict, deps: w2.deps });
  assert.strictEqual(r2.state, "failed");
  assert.strictEqual(r2.gates[0].reviewer.profile, "profile-claude-review");
  assert.match(w2.seen.facts[0].markdown, /Reviewer: `profile-claude-review`/);
});

test("a fallback whose model family cannot be shown to differ is refused — the pipeline pauses on the primary instead", async () => {
  const factory = reviewFactory({ fallback_profile: "profile-codex-mini-review" });
  const w = world({
    review: () => outage(),
    independence: () => ({ ok: false, reason: "the fallback profile-codex-mini-review is the same model family (gpt-5) as the implementer" }),
  });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: w.deps });
  assert.strictEqual(res.state, "interrupted");
  assert.strictEqual(res.paused_until, RESET);
  assert.deepStrictEqual(w.seen.reviews.map((r) => r.profile), ["profile-codex-review"], "never a silent substitution");
  assert.strictEqual(w.seen.pools.routes, undefined);
});

test("a resumed pipeline keeps the reviewer its route selected", async () => {
  const factory = reviewFactory({ fallback_profile: "profile-claude-review" });
  const w = world({
    review: (args) => (args.gate.profile === "profile-claude-review" ? PASS : outage()),
    pools: { retry: { spent: 1 }, routes: { review: { profile: "profile-claude-review", fallback_for: "profile-codex-review", after: 1 } } },
  });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: w.deps });
  assert.strictEqual(res.state, "passed");
  assert.deepStrictEqual(w.seen.reviews.map((r) => r.profile), ["profile-claude-review"]);
});

// ------------------------------------------------------ provenance, signed --

test("the attested step carries the fallback reviewer, and it is covered by the digest", () => {
  const steps = [{ gate: "review", kind: "agent-review", verdict: "passed", head: "h", fact: "art-x", reviewer: { profile: "profile-claude-review", fallback_for: "profile-codex-review", after: 1 } }];
  const base = { item: { node_id: "task-demo", run_id: "run-abcdef12" }, factory: { id: "factory-test", definition: { factory: { id: "factory-test" }, gates: [] } }, environment: {}, now: () => T0 };
  const att = attestation.buildAttestationObject({ ...base, gate: { state: "passed", head: "h", gates: steps, facts: ["art-x"] } });
  assert.deepStrictEqual(att.gate.steps[0].reviewer, { profile: "profile-claude-review", fallback_for: "profile-codex-review" });
  const primary = attestation.buildAttestationObject({ ...base, gate: { state: "passed", head: "h", gates: [{ ...steps[0], reviewer: undefined }], facts: ["art-x"] } });
  assert.strictEqual("reviewer" in primary.gate.steps[0], false, "a primary-reviewed step is byte-identical");
  assert.notStrictEqual(att.digest, primary.digest, "the reviewer identity is inside what the digest binds");
});

// ------------------------------------------------------------ the work loop --

test("the resume scan does not age out a pipeline paused past the run ceiling", () => {
  const now = () => T0 + 30 * HOUR;
  const record = { run_id: "run-1", node_id: "task-demo", state: "done", terminal_state: "resolved", terminal_enforced: true, finished_at: new Date(T0).toISOString(), gate_state: "interrupted", gate_paused_until: new Date(RESET).toISOString() };
  const statuses = [{ worker_id: "w-dead", live: false, gating: [{ run_id: "run-1", node_id: "task-demo" }] }];
  const found = workLoop.orphanedGateRuns(statuses, { records: new Map([["run-1", record]]), now, maxAgeMs: 24 * HOUR });
  assert.deepStrictEqual(found.map((o) => o.run_id), ["run-1"]);
  const unpaused = workLoop.orphanedGateRuns(statuses, { records: new Map([["run-1", { ...record, gate_paused_until: undefined }]]), now, maxAgeMs: 24 * HOUR });
  assert.deepStrictEqual(unpaused, [], "an ordinary interrupted run still ages out as before");
});

test("the loop parks a PAUSED pipeline until its wake — not the retry window — and its slot takes other work meanwhile", async () => {
  const marks = [];
  const logs = [];
  const state = { clock: T0, ticks: 0 };
  const control = { stopping: false, reason: null, wake: () => {} };
  const wakeAt = T0 + 20 * 60000;
  const calls = [];
  const dispatched = [];
  const deps = {
    now: () => state.clock,
    log: (l) => logs.push(l),
    publish: () => {},
    candidates: async () => (["task-a", "task-b"].filter((id) => !dispatched.includes(id)).slice(0, 1).map((id) => ({ id, readiness: "agent" }))),
    dispatch: async (item) => {
      dispatched.push(item.id);
      return { ok: true, run: { run_id: `run-${item.id}`, harness: "fake" } };
    },
    pollRuns: async (ids) => ids.map((id) => ({ run_id: id, terminal: true, record: { run_id: id, node_id: id.replace(/^run-/, ""), state: "done", terminal_state: "resolved", terminal_enforced: true } })),
    gate: async (entry) => {
      calls.push({ at: state.clock, node: entry.node_id });
      if (entry.node_id === "task-a" && calls.filter((c) => c.node === "task-a").length === 1) {
        return { state: "interrupted", outage_interrupted: true, gates: [], facts: [], reason: "the review lane profile-codex-review is out", paused_until: wakeAt, paused_profile: "profile-codex-review" };
      }
      if (entry.node_id === "task-a") control.stopping = true;
      return { state: "passed", gates: [], facts: [] };
    },
    markGate: (runId, patch) => {
      marks.push({ run_id: runId, ...patch });
      return { run_id: runId, state: "done", terminal_state: "resolved", terminal_enforced: true, ...patch };
    },
    sleep: async (ms) => {
      state.clock += ms;
      await new Promise((r) => setImmediate(r));
      if ((state.ticks += 1) >= 200) control.stopping = true; // a backstop
    },
  };
  await workLoop.runWorkLoop({ opts: { workerId: "w", concurrency: 1, intervalMs: 1000, maxIntervalMs: 60000, retryAfterMs: 5000 }, deps, control });
  const a = calls.filter((c) => c.node === "task-a");
  assert.strictEqual(a.length, 2, logs.join("\n"));
  assert.ok(a[1].at >= wakeAt, `re-offered at the wake, not after the ${5}s retry window (after ${(a[1].at - a[0].at) / 1000}s)`);
  assert.ok(dispatched.includes("task-b") && calls.find((c) => c.node === "task-b").at < wakeAt, "the freed slot took other work during the pause");
  const pausedMark = marks.find((m) => m.run_id === "run-task-a" && m.gate_state === "interrupted");
  assert.strictEqual(pausedMark.gate_paused_until, new Date(wakeAt).toISOString(), "the wake rides the run record");
  assert.strictEqual(pausedMark.gate_paused_profile, "profile-codex-review");
  assert.ok(logs.some((l) => /gates paused until/.test(l)), logs.join("\n"));
});

test("a gate fact with no reviewer route renders exactly as if the field did not exist", () => {
  const args = { gate: { id: "review", kind: "agent-review", profile: "p" }, nodeId: "task-demo", runId: "run-abcdef12", project: "demo", verdict: "passed", detail: "ok", attempts: [], date: "2026-09-05", factory: "factory-test" };
  const plain = gateRunner.buildGateFact(args).markdown;
  assert.strictEqual(gateRunner.buildGateFact({ ...args, reviewer: null }).markdown, plain);
  const routed = gateRunner.buildGateFact({ ...args, reviewer: { profile: "q", fallback_for: "p", after: 1 } }).markdown;
  assert.strictEqual(routed.split("\n").length, plain.split("\n").length + 1, "the Reviewer line is the ONLY line added, and only when routed");
});

test("a fallback's blocking verdict keeps its reviewer when the fix cycle cannot run", async () => {
  const factory = reviewFactory({ fallback_profile: "profile-claude-review" });
  const w = world({
    review: (args) => (args.gate.profile === "profile-codex-review" ? outage() : { ok: true, text: '```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"lib/x.js","summary":"off by one","evidence":"ran it"}]}\n```' }),
  });
  w.deps.fix = async () => ({ ok: false, reason: "the fixer's profile is unsatisfiable here" });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: w.deps });
  assert.strictEqual(res.state, "failed");
  assert.ok(res.gates.every((g) => g.reviewer && g.reviewer.profile === "profile-claude-review"), JSON.stringify(res.gates.map((g) => g.reviewer)));
  const gateFacts = w.seen.facts.filter((f) => f.id.startsWith("art-gate-"));
  assert.ok(gateFacts.length >= 1);
  assert.ok(gateFacts.every((f) => /Reviewer: `profile-claude-review`/.test(f.markdown)), "every gate fact under the fallback names it");
});

test("a stopping worker records the fallback route but dispatches nothing under it", async () => {
  const factory = reviewFactory({ fallback_profile: "profile-claude-review" });
  const w = world({ review: (args) => (args.gate.profile === "profile-codex-review" ? outage() : PASS) });
  let stop = false;
  w.deps.stopping = () => stop;
  const inner = w.deps.review;
  w.deps.review = async (args) => { const r = await inner(args); stop = true; return r; };
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps: w.deps });
  assert.strictEqual(res.state, "interrupted");
  assert.deepStrictEqual(w.seen.reviews.map((r) => r.profile), ["profile-codex-review"]);
  assert.strictEqual(w.seen.pools.routes.review.profile, "profile-claude-review", "the resume takes the route");
  assert.strictEqual(w.seen.pools.retry.spent, 1);
});
