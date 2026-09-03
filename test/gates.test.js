// The FACTORY DEFINITION vocabulary (lib/kernel/gates.js,
// task-spor-work-gate-pipeline) — the pure half of the gate pipeline: parsing a
// graph-resident factory, folding inline and referenced gates into one list,
// matching declared globs against a diff, and reading a review's structured
// verdict.
//
// The properties worth pinning here are the FAIL-CLOSED ones. A definition that
// does not validate must refuse (a worker that runs ungated on a typo is the
// failure mode enforcement-in-code exists to remove), and an unreadable review
// verdict must never read as a pass.
const test = require("node:test");
const assert = require("node:assert");

const gates = require("../lib/kernel/gates.js");

function factoryBody(payload) {
  return ["Some prose about this factory.", "", "```json", JSON.stringify(payload, null, 2), "```", ""].join("\n");
}

const INLINE = {
  factory: "demo",
  trusted_ref: "main",
  protected_paths: ["test/**"],
  test_lane_profile: "profile-test-writer",
  risk_classes: { "touches:auth": ["lib/auth.js", "**/auth/**"] },
  gates: [
    { id: "acceptance", kind: "command", command: "npm test" },
    { id: "review", kind: "agent-review", profile: "profile-codex-review", cycles: 2 },
    { id: "security", kind: "human", risk: ["touches:auth"] },
  ],
};

test("a factory declares an ordered list of the three gate kinds", () => {
  const { factory, errors } = gates.parseFactory(factoryBody(INLINE), { id: "factory-demo" });
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(
    factory.gates.map((g) => [g.id, g.kind]),
    [["acceptance", "command"], ["review", "agent-review"], ["security", "human"]]
  );
  assert.strictEqual(factory.trustedRef, "main");
  assert.strictEqual(factory.testLaneProfile, "profile-test-writer");
  assert.strictEqual(factory.gates[1].cycles, 2);
  assert.strictEqual(factory.gates[0].timeoutMs, gates.GATE_DEFAULTS.commandTimeoutMs);
});

test("an INLINE gate and a REFERENCED shareable gate node fold into the same object", () => {
  const shared = { id: "adversarial", kind: "agent-review", profile: "profile-codex-review", cycles: 2 };
  const inline = gates.parseFactory(factoryBody({ ...INLINE, gates: [{ ...shared }] }), { id: "factory-demo" });
  const referenced = gates.parseFactory(
    factoryBody({ ...INLINE, gates: [{ ref: "gate-adversarial" }] }),
    { id: "factory-demo", gateNodes: new Map([["gate-adversarial", shared]]) }
  );
  assert.deepStrictEqual(inline.errors, []);
  assert.deepStrictEqual(referenced.errors, []);
  // Identical but for the provenance stamp — which is the only thing downstream
  // is allowed to be able to tell apart.
  const { source: a, ...inlineGate } = inline.factory.gates[0];
  const { source: b, ...refGate } = referenced.factory.gates[0];
  assert.deepStrictEqual(refGate, inlineGate);
  assert.strictEqual(a, "inline");
  assert.strictEqual(b, "gate-adversarial");
});

test("keys written beside a ref override the shared gate's own", () => {
  const shared = { id: "adversarial", kind: "agent-review", profile: "profile-codex-review", cycles: 5 };
  const { factory, errors } = gates.parseFactory(
    factoryBody({ ...INLINE, gates: [{ ref: "gate-adversarial", cycles: 1 }] }),
    { id: "f", gateNodes: new Map([["gate-adversarial", shared]]) }
  );
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(factory.gates[0].cycles, 1);
  assert.strictEqual(factory.gates[0].profile, "profile-codex-review");
});

test("a reference the graph could not supply is an ERROR, never a silently dropped gate", () => {
  const { factory, errors } = gates.parseFactory(factoryBody({ ...INLINE, gates: [{ ref: "gate-missing" }] }), { id: "f" });
  assert.strictEqual(factory, null);
  assert.match(errors.join("\n"), /gate-missing/);
});

test("a definition that does not validate refuses — the worker never runs on a half-read factory", () => {
  const cases = [
    [{ ...INLINE, gates: [{ id: "x", kind: "command" }] }, /needs a 'command'/],
    [{ ...INLINE, gates: [{ id: "x", kind: "agent-review" }] }, /needs a 'profile'/],
    [{ ...INLINE, gates: [{ id: "x", kind: "smoke-test", command: "y" }] }, /must be one of/],
    [{ ...INLINE, gates: [] }, /declares no gates/],
    [{ ...INLINE, test_lane_profile: "", gates: INLINE.gates.slice(0, 1) }, /no separate lane to route to/],
    [{ ...INLINE, gates: [{ id: "a", kind: "human", risk: ["touches:nothing"] }] }, /not declared in 'risk_classes'/],
    [
      { ...INLINE, gates: [{ id: "dup", kind: "command", command: "a" }, { id: "dup", kind: "command", command: "b" }] },
      /duplicate gate id/,
    ],
  ];
  for (const [payload, re] of cases) {
    const { factory, errors } = gates.parseFactory(factoryBody(payload), { id: "f" });
    assert.strictEqual(factory, null, `expected a refusal for ${JSON.stringify(payload.gates)}`);
    assert.match(errors.join("\n"), re);
  }
});

test("a factory declares the repos it may judge, defaulting to its own project stamp", () => {
  // issue-spor-work-scope-union-factory-mismatch: the worker's --project token
  // unions a grouping, so what a factory may GATE has to be declared on the
  // factory rather than inferred from however the worker was scoped.
  const declared = gates.parseFactory(factoryBody({ ...INLINE, repos: ["spor-server", "Spor-Docs"] }), { id: "f", project: "spor" });
  assert.deepStrictEqual(declared.errors, []);
  assert.deepStrictEqual(declared.factory.repos, ["spor-server", "spor-docs"], "declared repos win over the node's own stamp, normalized");

  const inherited = gates.parseFactory(factoryBody(INLINE), { id: "f", project: "spor-server" });
  assert.deepStrictEqual(inherited.factory.repos, ["spor-server"], "undeclared falls back to the factory node's own project");

  const unscoped = gates.parseFactory(factoryBody(INLINE), { id: "f" });
  assert.deepStrictEqual(unscoped.factory.repos, [], "neither declared nor stamped: unscoped, exactly as before this field");

  // Fail closed on a typo: an empty `repos` reads like "judge everything",
  // which is the very bug — so it refuses instead.
  const empty = gates.parseFactory(factoryBody({ ...INLINE, repos: [] }), { id: "f", project: "spor" });
  assert.strictEqual(empty.factory, null);
  assert.match(empty.errors.join("\n"), /'repos' is declared but names no repo/);
});

test("repoScope tolerates the node-id spelling one way only, and an unstamped item is outside every scope", () => {
  const scope = gates.repoScope(["spor-server"]);
  assert.strictEqual(gates.inRepoScope("spor-server", scope), true);
  assert.strictEqual(gates.inRepoScope("SPOR-SERVER", scope), true, "case is not identity");
  assert.strictEqual(gates.inRepoScope("spor", scope), false, "a sibling repo in the same grouping is OUT");
  // Declaring the `repo-<slug>` node-id form also admits items stamped with the
  // bare slug, which is what an item actually carries.
  assert.strictEqual(gates.inRepoScope("spor-server", gates.repoScope(["repo-spor-server"])), true);
  // The inverse is deliberately NOT true: a repo genuinely named `repo-tools`
  // is a different repo from `tools`, and admitting it would be a fail-OPEN in
  // a guard whose whole job is to fail closed.
  assert.strictEqual(gates.inRepoScope("repo-tools", gates.repoScope(["tools"])), false);
  assert.strictEqual(gates.inRepoScope("repo-", gates.repoScope([""])), true, "an empty declaration is no scope at all, not a `repo-` wildcard");
  // Fail closed: no stamp, no idea which repo — do not gate it.
  assert.strictEqual(gates.inRepoScope(null, scope), false);
  assert.strictEqual(gates.inRepoScope("", scope), false);
  // An empty scope is "unscoped" and admits everything, including no stamp.
  for (const p of ["anything", null, ""]) assert.strictEqual(gates.inRepoScope(p, gates.repoScope([])), true);
});

test("a node with no fenced json payload is not a factory", () => {
  const { factory, errors } = gates.parseFactory("just prose", { id: "f" });
  assert.strictEqual(factory, null);
  assert.match(errors.join("\n"), /no fenced ```json payload/);
});

test("protectedHits names the protected test paths a change touched", () => {
  const changed = ["lib/graph.js", "test/graph.test.js", "docs/x.md", "conformance/goldens/a.txt"];
  assert.deepStrictEqual(gates.protectedHits(changed, ["test/**", "conformance/"]), [
    "test/graph.test.js",
    "conformance/goldens/a.txt",
  ]);
  assert.deepStrictEqual(gates.protectedHits(["lib/graph.js"], ["test/**"]), []);
  // No declared protected paths = nothing is protected (and the definition
  // parser already refuses paths without a lane).
  assert.deepStrictEqual(gates.protectedHits(changed, []), []);
});

test("a human gate arms only on the risk classes its change actually touched", () => {
  const riskClasses = { "touches:auth": ["lib/auth.js"], "touches:money": ["billing/**"] };
  const gate = { risk: ["touches:auth"] };
  assert.strictEqual(gates.humanGateArmed(gate, ["lib/auth.js"], riskClasses).armed, true);
  assert.strictEqual(gates.humanGateArmed(gate, ["billing/x.js"], riskClasses).armed, false);
  assert.strictEqual(gates.humanGateArmed(gate, [], riskClasses).armed, false);
  // A gate naming NO class is unconditional.
  assert.strictEqual(gates.humanGateArmed({ risk: [] }, ["README.md"], riskClasses).armed, true);
  const armed = gates.armedRiskClasses(["lib/auth.js", "billing/x.js"], riskClasses);
  assert.deepStrictEqual(armed.map((a) => a.class), ["touches:auth", "touches:money"]);
});

test("a review verdict is READ from its structured block — and anything unreadable fails closed", () => {
  const pass = gates.parseReviewVerdict('prose\n```json\n{"verdict": "pass", "findings": []}\n```\n');
  assert.deepStrictEqual([pass.ok, pass.passed], [true, true]);

  const changes = gates.parseReviewVerdict(
    '```json\n{"verdict": "changes_requested", "findings": [{"severity":"blocking","file":"a.js","summary":"off by one","evidence":"node -e ... prints 4, expected 3"}]}\n```'
  );
  assert.deepStrictEqual([changes.ok, changes.passed, changes.findings.length], [true, false, 1]);
  assert.match(gates.renderFindings(changes.findings), /\[blocking\] a\.js — off by one/);

  // findings with no verdict word: empty passes; a non-blocking one is a
  // pass with notes; a demonstrated blocking one is not.
  assert.strictEqual(gates.parseReviewVerdict('```json\n{"findings": []}\n```').passed, true);
  assert.strictEqual(gates.parseReviewVerdict('```json\n{"findings": [{"summary":"x"}]}\n```').passed, true);
  assert.strictEqual(gates.parseReviewVerdict('```json\n{"findings": [{"severity":"blocking","summary":"x","evidence":"npm test fails"}]}\n```').passed, false);

  // The LAST block wins — a reviewer that quotes the schema before answering.
  const quoted = gates.parseReviewVerdict(
    'I will answer as\n```json\n{"verdict": "pass"}\n```\nand my answer is\n```json\n{"verdict": "changes_requested", "findings": [{"severity":"blocking","summary":"x","evidence":"repro"}]}\n```'
  );
  assert.strictEqual(quoted.passed, false);

  // A "pass" that reports its own blocking findings contradicts itself, and the
  // findings win — taking the word over the evidence is the laundering this
  // parser exists to prevent.
  const contradictory = gates.parseReviewVerdict(
    '```json\n{"verdict":"pass","findings":[{"severity":"blocking","file":"a.js","summary":"drops records","evidence":"the sync test drops row 3"}]}\n```'
  );
  assert.strictEqual(contradictory.passed, false);
  assert.strictEqual(contradictory.findings.length, 1);
  assert.match(contradictory.error, /blocking/);
  // A pass WITH non-blocking notes is still a pass.
  assert.strictEqual(
    gates.parseReviewVerdict('```json\n{"verdict":"pass","findings":[{"severity":"minor","summary":"nit"}]}\n```').passed,
    true
  );

  for (const bad of ["", "looks good to me!", "```json\n{not json}\n```", '```json\n{"verdict": "maybe"}\n```']) {
    const v = gates.parseReviewVerdict(bad);
    assert.strictEqual(v.ok, false, `expected ${JSON.stringify(bad)} to be unreadable`);
    assert.strictEqual(v.passed, false, "an unreadable verdict must never read as a pass");
  }
});

// task-spor-review-gate-stateful-bounded: the severity floor. Only `blocking`
// blocks, and only when the reviewer demonstrated it — the first live run's
// reviewer re-opened the gate every cycle on `major` notes and undemonstrated
// readings of the code, and the fix cycles chased a moving target.
test("only a DEMONSTRATED `blocking` finding blocks — major/critical are advisory, and blocking-without-evidence is downgraded", () => {
  const major = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"severity":"major","file":"a.js","summary":"stale checkpoint"},{"severity":"critical","summary":"was blocking under the old floor"}]}\n```');
  assert.deepStrictEqual([major.ok, major.passed], [true, true], "changes_requested with nothing blocking is a pass with notes");
  assert.strictEqual(major.verdict, "pass");
  assert.match(major.note, /rated nothing blocking/);
  assert.deepStrictEqual(major.findings.map((f) => f.blocking), [false, false]);

  const undemonstrated = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"a.js","summary":"I think this races"}]}\n```');
  assert.strictEqual(undemonstrated.passed, true, "a blocking finding nobody demonstrated does not block");
  assert.strictEqual(undemonstrated.findings[0].blocking, false);
  assert.match(undemonstrated.findings[0].note, /without evidence/);
  assert.match(gates.renderFindings(undemonstrated.findings), /\[blocking, advisory\] a\.js — I think this races \(rated blocking without evidence/);

  // Demonstrated: `evidence` (or its aliases) names what was run.
  for (const key of ["evidence", "reproduction", "repro"]) {
    const v = gates.parseReviewVerdict(`\`\`\`json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","summary":"x","${key}":"node test/a.test.js -> AssertionError"}]}\n\`\`\``);
    assert.strictEqual(v.passed, false, `${key} demonstrates the finding`);
    assert.strictEqual(v.findings[0].blocking, true);
  }
});

test("on a fix cycle a NEW blocking finding must be one the fix introduced — otherwise it is advisory, never a moved goalpost", () => {
  const text = (introduced) =>
    `\`\`\`json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"b.js","summary":"pre-existing race","evidence":"repro script"${introduced === undefined ? "" : `,"introduced_by_fix":${introduced}`}}]}\n\`\`\``;
  // Cycle 0: no fix yet, so the attribution is not asked for.
  assert.strictEqual(gates.parseReviewVerdict(text(undefined), { cycle: 0 }).passed, false);
  // Cycle 1: not attributed to the fix -> advisory.
  const later = gates.parseReviewVerdict(text(undefined), { cycle: 1 });
  assert.strictEqual(later.passed, true);
  assert.match(later.findings[0].note, /not introduced by the fix/);
  assert.strictEqual(gates.parseReviewVerdict(text(false), { cycle: 1 }).passed, true);
  // Attributed AND demonstrated -> blocks.
  assert.strictEqual(gates.parseReviewVerdict(text(true), { cycle: 1 }).passed, false);
});

test("a verdict must answer every prior finding — one it ignores is unreadable and counts as changes_requested for the prior set only", () => {
  const prior = [
    { id: "F1", severity: "blocking", file: "a.js", summary: "cascade runs before the CAS" },
    { id: "F2", severity: "blocking", file: "a.js", summary: "auth reads a different snapshot" },
  ];
  // Memoryless: no `prior` at all, and a brand-new blocking finding.
  const memoryless = gates.parseReviewVerdict(
    '```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"c.js","summary":"the lock can expire","evidence":"repro","introduced_by_fix":true}]}\n```',
    { prior, cycle: 1 }
  );
  assert.strictEqual(memoryless.ok, false, "ignoring the prior set is unreadable");
  assert.strictEqual(memoryless.passed, false);
  assert.deepStrictEqual(memoryless.unanswered, ["F1", "F2"]);
  assert.deepStrictEqual(memoryless.findings.map((f) => f.id), ["F1", "F2"], "the fix cycle gets the PRIOR set, not the new finding");
  assert.match(memoryless.error, /ignored prior findings F1, F2/);

  // Half-answered: F1 cleared, F2 ignored -> still unreadable, and F2 alone stands.
  const half = gates.parseReviewVerdict('```json\n{"verdict":"pass","prior":[{"id":"F1","status":"resolved","note":"CAS now precedes the cascade"}],"findings":[]}\n```', { prior, cycle: 1 });
  assert.strictEqual(half.ok, false);
  assert.deepStrictEqual(half.unanswered, ["F2"]);
  assert.deepStrictEqual(half.findings.map((f) => f.id), ["F2"]);
  assert.strictEqual(half.prior.find((p) => p.id === "F1").status, "resolved", "the answered one is still recorded as cleared");

  // Fully answered: F1 cleared, F2 confirmed open -> readable, F2 blocks, and a
  // demonstrated fix-introduced finding joins it.
  const answered = gates.parseReviewVerdict(
    '```json\n{"verdict":"changes_requested","prior":[{"id":"F1","status":"resolved"},{"id":"F2","status":"open","note":"still two reads"}],"findings":[{"severity":"blocking","file":"c.js","summary":"the fix leaks the lock","evidence":"node repro.js hangs","introduced_by_fix":true},{"severity":"minor","summary":"nit"}]}\n```',
    { prior, cycle: 1 }
  );
  assert.strictEqual(answered.ok, true);
  assert.strictEqual(answered.passed, false);
  assert.deepStrictEqual(answered.findings.filter((f) => f.blocking).map((f) => f.id || f.summary), ["F2", "the fix leaks the lock"]);
  assert.strictEqual(answered.findings.find((f) => f.id === "F2").note, "still two reads");

  // An object-shaped `prior` map is the same answer.
  const mapped = gates.parseReviewVerdict('```json\n{"verdict":"pass","prior":{"F1":"resolved","F2":"fixed"},"findings":[]}\n```', { prior, cycle: 1 });
  assert.deepStrictEqual([mapped.ok, mapped.passed], [true, true]);

  // A "pass" that CONFIRMS a prior finding open contradicts itself; the finding wins.
  const confirmedPass = gates.parseReviewVerdict('```json\n{"verdict":"pass","prior":[{"id":"F1","status":"open"},{"id":"F2","status":"resolved"}]}\n```', { prior, cycle: 1 });
  assert.deepStrictEqual([confirmedPass.ok, confirmedPass.passed], [true, false]);
  assert.match(confirmedPass.error, /said 'pass' while a blocking finding stands/);
});

test("the finding ledger assigns stable ids, folds each verdict, and yields the next review's prior set", () => {
  let ledger = [];
  const c0 = gates.parseReviewVerdict(
    '```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"a.js","summary":"one","evidence":"e1"},{"severity":"major","summary":"note"},{"severity":"blocking","file":"b.js","summary":"two","evidence":"e2"}]}\n```',
    { prior: gates.openPriorFindings(ledger), cycle: 0 }
  );
  ledger = gates.applyReviewToLedger(ledger, c0, 0);
  assert.deepStrictEqual(ledger.map((e) => [e.id, e.status]), [["F1", "open"], ["F2", "advisory"], ["F3", "open"]]);
  assert.deepStrictEqual(gates.openPriorFindings(ledger).map((p) => p.id), ["F1", "F3"], "only open BLOCKING entries are carried as prior");

  const c1 = gates.parseReviewVerdict(
    '```json\n{"verdict":"changes_requested","prior":[{"id":"F1","status":"resolved"},{"id":"F3","status":"open"}],"findings":[{"severity":"blocking","summary":"regression","evidence":"e4","introduced_by_fix":true}]}\n```',
    { prior: gates.openPriorFindings(ledger), cycle: 1 }
  );
  ledger = gates.applyReviewToLedger(ledger, c1, 1);
  assert.deepStrictEqual(ledger.map((e) => [e.id, e.status, e.closed]), [["F1", "resolved", 1], ["F2", "advisory", null], ["F3", "open", null], ["F4", "open", null]]);
  assert.deepStrictEqual(gates.openPriorFindings(ledger).map((p) => p.id), ["F3", "F4"]);
  // Ids are never reused: a resolved F1 stays F1 on the record.
  assert.match(gates.renderLedger(ledger), /^F1 \[blocking\] resolved at cycle 1 — a\.js — one/m);
  assert.match(gates.renderLedger(ledger), /^F3 \[blocking\] OPEN since cycle 0/m);
  assert.match(gates.renderLedger(ledger), /^F2 \[major\] advisory \(cycle 0\)/m);

  // A memoryless verdict folds only its (empty) answers: nothing new is admitted.
  const c2 = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","summary":"fresh goalpost","evidence":"x","introduced_by_fix":true}]}\n```', { prior: gates.openPriorFindings(ledger), cycle: 2 });
  assert.strictEqual(c2.ok, false);
  ledger = gates.applyReviewToLedger(ledger, c2, 2);
  assert.strictEqual(ledger.length, 4, "the ignored-prior verdict's new finding is not on the ledger");
});

test("cycleDecision retries up to the declared cap, then escalates — `cycles: N` is exactly N fix cycles, and the history reads that way", () => {
  assert.strictEqual(gates.cycleDecision({ cycles: 2 }, 0), "retry");
  assert.strictEqual(gates.cycleDecision({ cycles: 2 }, 1), "retry");
  assert.strictEqual(gates.cycleDecision({ cycles: 2 }, 2), "escalate");
  // The default is no fix cycle at all: one failure escalates.
  assert.strictEqual(gates.cycleDecision({ cycles: 0 }, 0), "escalate");
  assert.strictEqual(gates.cycleDecision({}, 0), "escalate");
  assert.strictEqual(gates.cycleCap({ cycles: "3" }), 3);
  // Four attempts under cap 3 is not an overrun: it is the initial review plus
  // three fix cycles, and the escalation says so instead of "4 attempts, cap 3".
  const spent = gates.describeCycles({ cycles: 3 }, [{}, {}, {}, {}]);
  assert.deepStrictEqual([spent.reviews, spent.fixes, spent.cap], [4, 3, 3]);
  assert.strictEqual(spent.text, "4 attempts: the initial one plus 3 fix cycles, cap 3");
  assert.strictEqual(gates.describeCycles({ cycles: 0 }, [{}]).text, "1 attempt: the initial one plus 0 fix cycles, cap 0");
});

// Review finding 2 on the first cut of the stateful gate: an explicit
// `changes_requested` whose findings could not be read was filtered down to
// "nothing blocking" and PASSED. A request for changes that says nothing —
// no list, an empty list with no prior finding standing, or an entry the
// parser cannot read — is unreadable, and unreadable fails closed.
test("malformed or missing findings on an explicit changes_requested fail closed — never a pass laundered out of a filter", () => {
  const cases = [
    ['```json\n{"verdict":"changes_requested"}\n```', /carried no findings list/],
    ['```json\n{"verdict":"changes_requested","findings":[]}\n```', /empty findings list and no prior finding confirmed open/],
    ['```json\n{"verdict":"changes_requested","findings":["the lock is stolen"]}\n```', /1 of 1 findings is malformed/],
    ['```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"a.js","evidence":"npm test fails"}]}\n```', /malformed \(not an object with a summary\)/],
    ['```json\n{"verdict":"changes_requested","findings":[{"severity":"minor","summary":"nit"},42]}\n```', /1 of 2 findings is malformed/],
    // The word does not launder a malformed entry either way: a "pass" whose
    // findings cannot be read might be hiding the blocking one.
    ['```json\n{"verdict":"pass","findings":[null]}\n```', /malformed/],
  ];
  for (const [text, re] of cases) {
    const v = gates.parseReviewVerdict(text);
    assert.strictEqual(v.ok, false, `${text} must be unreadable`);
    assert.strictEqual(v.passed, false, `${text} must not pass`);
    assert.match(v.error, re);
    assert.match(v.error, /fails closed/);
  }
  // Well-formed advisory findings are still a pass with notes (rule 1).
  assert.strictEqual(gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"severity":"minor","summary":"nit"}]}\n```').passed, true);

  // On a fix cycle the prior answers survive an unreadable findings list: the
  // fixer is sent back at what is still OPEN, not at a finding the reviewer
  // just cleared, and an empty list beside a CONFIRMED prior finding is a
  // readable "F1 still stands".
  const prior = [{ id: "F1", severity: "blocking", summary: "off by one", evidence: "x" }, { id: "F2", severity: "blocking", summary: "drops rows", evidence: "y" }];
  const partial = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","prior":[{"id":"F1","status":"resolved"},{"id":"F2","status":"open"}],"findings":["junk"]}\n```', { prior, cycle: 1 });
  assert.strictEqual(partial.ok, false);
  assert.deepStrictEqual(partial.findings.map((f) => f.id), ["F2"], "the cleared prior finding stays cleared; the open one is what the fix gets");
  assert.deepStrictEqual(partial.prior.map((p) => [p.id, p.status]), [["F1", "resolved"], ["F2", "open"]]);
  const confirmed = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","prior":[{"id":"F1","status":"open"},{"id":"F2","status":"resolved"}],"findings":[]}\n```', { prior, cycle: 1 });
  assert.deepStrictEqual([confirmed.ok, confirmed.passed], [true, false]);
  assert.deepStrictEqual(confirmed.findings.map((f) => f.id), ["F1"]);
  // ...but clearing everything and still requesting changes says nothing.
  const contradictory = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","prior":[{"id":"F1","status":"resolved"},{"id":"F2","status":"resolved"}],"findings":[]}\n```', { prior, cycle: 1 });
  assert.strictEqual(contradictory.ok, false);
  assert.match(contradictory.error, /no prior finding confirmed open/);
});
