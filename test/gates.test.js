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
  assert.strictEqual(factory.gates[0].reruns, 0, "a command gate declares no reruns by default");
});

test("a command gate's `reruns` is a bounded same-tree rerun budget: default 0, declared as given, capped at 3, and read by rerunDecision", () => {
  const declared = gates.parseFactory(factoryBody({ ...INLINE, gates: [{ id: "acceptance", kind: "command", command: "npm test", reruns: 1 }] }), { id: "factory-demo" });
  assert.deepStrictEqual(declared.errors, []);
  assert.strictEqual(declared.factory.gates[0].reruns, 1);
  const capped = gates.parseFactory(factoryBody({ ...INLINE, gates: [{ id: "acceptance", kind: "command", command: "npm test", reruns: 99 }] }), { id: "factory-demo" });
  assert.strictEqual(capped.factory.gates[0].reruns, gates.GATE_DEFAULTS.maxReruns);
  const junk = gates.parseFactory(factoryBody({ ...INLINE, gates: [{ id: "acceptance", kind: "command", command: "npm test", reruns: "lots" }] }), { id: "factory-demo" });
  assert.strictEqual(junk.factory.gates[0].reruns, 0, "an unreadable value falls back to the default, never to unbounded");
  // attempt is 1-based: `reruns: 1` is exactly two runs.
  assert.strictEqual(gates.rerunDecision({ reruns: 1 }, 1), "rerun");
  assert.strictEqual(gates.rerunDecision({ reruns: 1 }, 2), "charge");
  assert.strictEqual(gates.rerunDecision({}, 1), "charge", "a definition with no reruns key is byte-identical to before the knob");
  assert.strictEqual(gates.rerunDecision(null, 1), "charge");
  assert.strictEqual(gates.rerunCap({ reruns: 7 }), gates.GATE_DEFAULTS.maxReruns);
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
test("only a DEMONSTRATED `blocking` finding blocks — major/critical are advisory, and blocking-without-evidence is advisory too, never a failure", () => {
  const major = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"severity":"major","file":"a.js","summary":"stale checkpoint"},{"severity":"critical","summary":"was blocking under the old floor"}]}\n```');
  assert.deepStrictEqual([major.ok, major.passed], [true, true], "changes_requested with nothing blocking is a pass with notes");
  assert.strictEqual(major.verdict, "pass");
  assert.match(major.note, /rated nothing blocking/);
  assert.deepStrictEqual(major.findings.map((f) => f.blocking), [false, false]);

  // Rule 5: a blocking finding nobody demonstrated cannot be ENFORCED, so an
  // explicit changes_requested backed only by such findings does not fail the
  // gate — the contract is demonstrated-only. (The second cut read this case
  // as fail-closed, which charged fix cycles and, at the cap, a person to
  // findings nobody demonstrated — review finding 1 on the third cut.) It is a
  // pass that carries the downgraded findings as advisory, with a note saying
  // exactly what the reviewer claimed and could not back.
  const undemonstrated = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"a.js","summary":"I think this races"}]}\n```');
  assert.deepStrictEqual([undemonstrated.ok, undemonstrated.passed], [true, true], "changes_requested backed by nothing demonstrated does not block");
  assert.strictEqual(undemonstrated.verdict, "pass");
  assert.strictEqual(undemonstrated.undemonstrated, 1);
  assert.match(undemonstrated.note, /rated 1 finding blocking but demonstrated none of them .* recorded as advisory; only a demonstrated blocking finding fails the gate/);
  assert.strictEqual(undemonstrated.error, undefined);
  assert.strictEqual(undemonstrated.findings[0].blocking, false);
  assert.match(undemonstrated.findings[0].note, /without evidence/);
  assert.match(gates.renderFindings(undemonstrated.findings), /\[blocking, advisory\] a\.js — I think this races \(rated blocking without evidence/);
  // A demonstrated blocking finding beside an undemonstrated one is an
  // ordinary changes_requested (the demonstrated one blocks, readably).
  const mixed = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","summary":"argued"},{"severity":"blocking","summary":"shown","evidence":"npm test fails"}]}\n```');
  assert.deepStrictEqual([mixed.ok, mixed.passed, mixed.findings.map((f) => f.blocking)], [true, false, [false, true]]);
  // …and a "pass" that lists an undemonstrated blocking finding is what the
  // reviewer said it is: a pass with an advisory note (rule 5 is about a
  // request for changes the protocol cannot back, not about notes).
  const passNote = gates.parseReviewVerdict('```json\n{"verdict":"pass","findings":[{"severity":"blocking","summary":"maybe"}]}\n```');
  assert.deepStrictEqual([passNote.ok, passNote.passed], [true, true]);

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

// Review finding 3 on the second cut: `withLedgerIds` keyed the minted entries
// by `opened === cycle`, so a review RE-RUN at a cycle whose earlier attempt had
// already minted entries handed the new finding an old id. The minted set is
// now "what the fold appended past the pre-fold ledger", and the redo path
// rolls the earlier attempt's fold back first.
test("ledger ids are minted from the fold, not from the cycle stamp — a same-cycle redo cannot alias an earlier attempt's entry", () => {
  const before = [
    { id: "F1", severity: "blocking", summary: "first attempt finding", blocking: true, status: "open", opened: 1, closed: null },
  ];
  const v = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","summary":"the redo finding","evidence":"e","introduced_by_fix":true}]}\n```', { cycle: 1 });
  const next = gates.applyReviewToLedger(before, v, 1);
  const named = gates.withLedgerIds(v.findings, next, before);
  assert.strictEqual(named[0].id, "F2", "the redo finding gets the id the fold minted for it, not F1");
  assert.deepStrictEqual(next.map((e) => [e.id, e.summary]), [["F1", "first attempt finding"], ["F2", "the redo finding"]]);
  // The legacy call shape (a cycle number) still reads by stamp.
  assert.strictEqual(gates.withLedgerIds(v.findings, next, 1)[0].id, "F1");
  // A reviewer-invented id that names nothing on the ledger is replaced by
  // the minted one, so the fixer and the next review use one name.
  const invented = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"id":"BUG-7","severity":"blocking","summary":"x","evidence":"e"}]}\n```');
  const folded = gates.applyReviewToLedger([], invented, 0);
  assert.strictEqual(gates.withLedgerIds(invented.findings, folded, [])[0].id, "F1");

  // rollbackCycle: the entries a cycle minted are dropped, the prior findings
  // it answered reopen — the ledger the first attempt at that cycle saw.
  const ledger = [
    { id: "F1", severity: "blocking", summary: "a", blocking: true, status: "resolved", opened: 0, closed: 2, answered: 2, note: "fixed" },
    { id: "F2", severity: "blocking", summary: "b", blocking: true, status: "open", opened: 1, closed: null, answered: 2 },
    { id: "F3", severity: "blocking", summary: "c", blocking: true, status: "open", opened: 2, closed: null },
  ];
  const rolled = gates.rollbackCycle(ledger, 2);
  assert.deepStrictEqual(rolled.map((e) => [e.id, e.status, e.closed, e.answered]), [["F1", "open", null, null], ["F2", "open", null, null]]);
  assert.deepStrictEqual(gates.openPriorFindings(rolled).map((p) => p.id), ["F1", "F2"]);
});

// The `raised` set: a finding rated blocking but undemonstrated on an earlier
// cycle rides the ledger as advisory. A later review that demonstrates it BY
// ID is upgrading a finding it did raise — not moving the goalposts — so the
// introduced-by-fix floor does not apply, and the ledger upgrades the entry in
// place rather than minting a second one.
test("a later review may demonstrate an earlier undemonstrated blocking finding by id — an upgrade, not a goalpost", () => {
  const c0 = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"a.js","summary":"I think this races"}]}\n```', { cycle: 0 });
  assert.deepStrictEqual([c0.ok, c0.passed], [true, true], "rule 5: an undemonstrated request for changes is a pass with an advisory note");
  let ledger = gates.applyReviewToLedger([], c0, 0);
  assert.deepStrictEqual(ledger.map((e) => [e.id, e.status]), [["F1", "advisory"]]);
  const raised = gates.raisedUndemonstrated(ledger);
  assert.deepStrictEqual(raised.map((r) => r.id), ["F1"]);
  assert.deepStrictEqual(gates.openPriorFindings(ledger), [], "an advisory entry is not in the prior set");

  // Without the id (or without evidence) it is still a goalpost on a fix cycle.
  const goalpost = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"a.js","summary":"it races","evidence":"node race.js hangs"}]}\n```', { cycle: 1, raised });
  assert.strictEqual(goalpost.findings[0].blocking, false);
  assert.match(goalpost.findings[0].note, /not introduced by the fix/);

  // Named by id and demonstrated: blocks, and F1 is upgraded in place.
  const upgrade = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"id":"F1","severity":"blocking","file":"a.js","summary":"it races","evidence":"node race.js hangs"}]}\n```', { cycle: 1, raised });
  assert.deepStrictEqual([upgrade.ok, upgrade.passed, upgrade.findings[0].blocking], [true, false, true]);
  assert.match(upgrade.findings[0].note, /raised undemonstrated on an earlier cycle, now demonstrated/);
  // The upgrade's identity is the LEDGER's: F1's file and summary stay, the
  // reviewer's new wording rides beside them as a restatement.
  assert.deepStrictEqual([upgrade.findings[0].file, upgrade.findings[0].summary, upgrade.findings[0].restated], ["a.js", "I think this races", "it races"]);
  ledger = gates.applyReviewToLedger(ledger, upgrade, 1);
  assert.deepStrictEqual(ledger.map((e) => [e.id, e.status, e.evidence, e.demonstrated]), [["F1", "open", "node race.js hangs", 1]]);
  assert.deepStrictEqual(gates.withLedgerIds(upgrade.findings, ledger, [ledger[0]]).map((f) => f.id), ["F1"]);
  assert.deepStrictEqual(gates.openPriorFindings(ledger).map((p) => p.id), ["F1"], "…and now it is a prior finding the next review must answer");
  // Rolling the upgrade cycle back returns it to advisory.
  assert.deepStrictEqual(gates.rollbackCycle(ledger, 1).map((e) => [e.id, e.status, e.blocking]), [["F1", "advisory", false]]);
});

// Review finding 2 on the third cut: a verdict that cannot be read at all —
// an unrecognized verdict word, or no structured verdict anywhere — used to
// come back with an EMPTY findings list, so on a fix cycle the fixer was sent
// off with nothing to fix and the prior blocking set silently dropped out of
// the cycle. Unreadable answers nothing: the whole prior set is carried, open.
test("an unrecognized or absent fix-cycle verdict carries the prior blocking set to the fixer instead of discarding it", () => {
  const prior = [
    { id: "F1", severity: "blocking", file: "a.js", summary: "races", evidence: "node race.js", opened: 0 },
    { id: "F2", severity: "blocking", file: "b.js", summary: "loses data", evidence: "npm test", opened: 0 },
  ];
  const odd = gates.parseReviewVerdict('```json\n{"verdict":"needs_work","findings":[]}\n```', { prior, cycle: 1 });
  assert.strictEqual(odd.ok, false);
  assert.match(odd.error, /unrecognized verdict 'needs_work' — fails closed for the prior set/);
  assert.deepStrictEqual(odd.findings.map((f) => [f.id, f.origin, f.blocking, f.status]), [["F1", "prior", true, "open"], ["F2", "prior", true, "open"]]);
  assert.deepStrictEqual(odd.prior.map((p) => p.id), ["F1", "F2"]);
  assert.match(odd.findings[0].note, /not answered by this review/);

  const prose = gates.parseReviewVerdict("Looks fine to me, ship it.", { prior, cycle: 1 });
  assert.strictEqual(prose.ok, false);
  assert.match(prose.error, /no structured verdict found in the review report — fails closed for the prior set/);
  assert.deepStrictEqual(prose.findings.map((f) => f.id), ["F1", "F2"]);
  assert.ok(prose.findings.every((f) => f.blocking && f.status === "open"));
  // Folded, the ledger still carries both open — the next review is asked again.
  const ledger = [
    { id: "F1", severity: "blocking", file: "a.js", summary: "races", evidence: "node race.js", blocking: true, status: "open", opened: 0, closed: null },
    { id: "F2", severity: "blocking", file: "b.js", summary: "loses data", evidence: "npm test", blocking: true, status: "open", opened: 0, closed: null },
  ];
  const next = gates.applyReviewToLedger(ledger, prose, 1);
  assert.deepStrictEqual(gates.openPriorFindings(next).map((p) => p.id), ["F1", "F2"]);
  assert.strictEqual(gates.renderFindings(prose.findings).split("\n").length, 2, "the fixer's evidence block names both");
  // With no prior set there is nothing to carry — same failure, empty list.
  const first = gates.parseReviewVerdict("no json here", { cycle: 0 });
  assert.deepStrictEqual([first.ok, first.findings, first.prior], [false, [], []]);
  assert.strictEqual(first.error, "no structured verdict found in the review report");
});

// Review finding 3 on the third cut: rolling back the cycle that UPGRADED an
// advisory entry (demonstrated it by id) reset its status but left the
// upgrade's evidence on it, so the rolled-back entry no longer read as
// undemonstrated and the redo's reviewer could not demonstrate it by id.
test("rolling back an upgrade cycle restores the entry exactly — evidence included — so it is demonstrable again on the redo", () => {
  const c0 = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"a.js","summary":"I think this races"}]}\n```', { cycle: 0 });
  let ledger = gates.applyReviewToLedger([], c0, 0);
  const raised = gates.raisedUndemonstrated(ledger);
  assert.deepStrictEqual(raised.map((r) => r.id), ["F1"]);
  const upgrade = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"id":"F1","severity":"blocking","file":"a.js","summary":"it races","evidence":"node race.js hangs"}]}\n```', { cycle: 1, raised });
  const upgraded = gates.applyReviewToLedger(ledger, upgrade, 1);
  assert.deepStrictEqual(upgraded.map((e) => [e.id, e.status, e.evidence]), [["F1", "open", "node race.js hangs"]]);
  assert.strictEqual(upgraded[0].prev.cycle, 1, "the fold snapshots the entry before it touches it");
  const rolled = gates.rollbackCycle(upgraded, 1);
  assert.deepStrictEqual(rolled.map((e) => [e.id, e.status, e.blocking, e.evidence, e.demonstrated]), [["F1", "advisory", false, "", null]]);
  assert.strictEqual(rolled[0].prev, undefined, "the snapshot is consumed by the rollback");
  assert.deepStrictEqual(gates.raisedUndemonstrated(rolled).map((r) => r.id), ["F1"], "the redo's reviewer may demonstrate F1 by id again");
  // The note the upgrade wrote is gone with it too.
  assert.strictEqual(rolled[0].note, ledger[0].note);
  // A ledger folded before snapshots existed rolls back field by field, and
  // an upgrade's evidence goes with the upgrade there as well.
  const legacy = [{ id: "F1", severity: "blocking", file: "a.js", summary: "it races", evidence: "node race.js hangs", blocking: true, status: "open", opened: 0, closed: null, demonstrated: 1 }];
  assert.deepStrictEqual(gates.rollbackCycle(legacy, 1).map((e) => [e.status, e.evidence]), [["advisory", ""]]);
  assert.deepStrictEqual(gates.raisedUndemonstrated(gates.rollbackCycle(legacy, 1)).map((r) => r.id), ["F1"]);
  // A prior answer is snapshotted the same way: resolving F1 at cycle 2 and
  // rolling cycle 2 back returns its note along with its status.
  const answered = gates.applyReviewToLedger(upgraded, gates.parseReviewVerdict('```json\n{"verdict":"pass","prior":[{"id":"F1","status":"resolved","note":"fixed in 2"}]}\n```', { prior: gates.openPriorFindings(upgraded), cycle: 2 }), 2);
  assert.deepStrictEqual([answered[0].status, answered[0].note], ["resolved", "fixed in 2"]);
  const back = gates.rollbackCycle(answered, 2);
  assert.deepStrictEqual([back[0].status, back[0].closed, back[0].note, back[0].evidence], ["open", null, upgraded[0].note, "node race.js hangs"]);
  assert.strictEqual(back[0].prev.cycle, 1, "the earlier cycle's snapshot survives, so a further rollback still has it");
});

// Review finding 4 on the third cut: a fresh, demonstrated blocking finding
// that REUSED the id of a resolved ledger entry was dropped by the fold (the
// id matched an existing entry that was not advisory), so it never reached the
// ledger, the fixer, or the next review's prior set.
test("a fresh blocking finding that reuses a resolved ledger id is minted as a new entry, not silently dropped", () => {
  const before = [
    { id: "F1", severity: "blocking", file: "a.js", summary: "first bug", evidence: "npm test", blocking: true, status: "resolved", opened: 0, closed: 1, answered: 1 },
  ];
  const v = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"id":"F1","severity":"blocking","file":"b.js","summary":"the fix broke b","evidence":"node b.test.js fails","introduced_by_fix":true}]}\n```', { prior: [], cycle: 2 });
  assert.deepStrictEqual([v.ok, v.passed, v.findings.length, v.findings[0].blocking], [true, false, 1, true]);
  const next = gates.applyReviewToLedger(before, v, 2);
  assert.deepStrictEqual(next.map((e) => [e.id, e.status, e.summary]), [["F1", "resolved", "first bug"], ["F2", "open", "the fix broke b"]]);
  assert.match(next[1].note, /already-used ledger id F1; recorded as F2/);
  const named = gates.withLedgerIds(v.findings, next, before);
  assert.strictEqual(named[0].id, "F2", "the fixer is told the minted name, not the reused one");
  assert.deepStrictEqual(gates.openPriorFindings(next).map((p) => p.id), ["F2"], "…and the next review must answer it");
  // Reusing an OPEN prior id under `findings` is still an answer, not a new
  // finding (the prior answer carries it) — unchanged.
  const open = [{ id: "F1", severity: "blocking", file: "a.js", summary: "still open", evidence: "npm test", blocking: true, status: "open", opened: 0, closed: null }];
  const again = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","prior":[{"id":"F1","status":"open"}],"findings":[{"id":"F1","severity":"blocking","summary":"still open","evidence":"npm test"}]}\n```', { prior: gates.openPriorFindings(open), cycle: 1 });
  assert.deepStrictEqual(gates.applyReviewToLedger(open, again, 1).map((e) => e.id), ["F1"]);
});

// Review finding 2 on the third cut: `evidence: true` (or a number, an object,
// a bare "yes") was stringified and passed the evidence check, so any truthy
// value was a one-token key to the blocking floor. Evidence is a non-empty
// string naming what was run, and nothing else.
test("evidence must be a real string — a boolean, number, object or bare affirmation is not a demonstration", () => {
  for (const bad of [true, 1, {}, ["npm test"], "yes", " TRUE ", "n/a", "-", ""]) {
    const v = gates.parseReviewVerdict(`\`\`\`json\n${JSON.stringify({ verdict: "changes_requested", findings: [{ severity: "blocking", file: "a.js", summary: "races", evidence: bad }] })}\n\`\`\``);
    assert.strictEqual(v.findings[0].blocking, false, `evidence ${JSON.stringify(bad)} does not demonstrate`);
    assert.strictEqual(v.findings[0].evidence, "", `evidence ${JSON.stringify(bad)} is recorded as none`);
    assert.strictEqual(v.passed, true, "…so the request for changes is advisory");
  }
  // The aliases are read the same way, and a real string still counts.
  const good = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"a.js","summary":"races","evidence":true,"reproduction":"node race.js hangs after 3 runs"}]}\n```');
  assert.deepStrictEqual([good.findings[0].blocking, good.findings[0].evidence, good.passed], [true, "node race.js hangs after 3 runs", false]);
});

// Review finding 3 on the third cut: a later reviewer could put a DIFFERENT
// defect under an earlier advisory finding's id — the id alone unlocked the
// upgrade path, skipping the introduced-by-fix floor and rewriting what the
// fixer was told F1 was. An upgrade must describe the same file, and its
// identity comes from the ledger.
test("an upgrade by id must be the same finding — a different file under a borrowed id is a new finding, subject to the fix-cycle floor", () => {
  const c0 = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"severity":"blocking","file":"a.js","summary":"I think a races"}]}\n```', { cycle: 0 });
  const ledger = gates.applyReviewToLedger([], c0, 0);
  const raised = gates.raisedUndemonstrated(ledger);
  assert.deepStrictEqual(raised.map((r) => [r.id, r.file]), [["F1", "a.js"]]);
  // Borrowed id, different file, no introduced_by_fix: a goalpost, advisory.
  const borrowed = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"id":"F1","severity":"blocking","file":"b.js","summary":"b loses data","evidence":"node b.test.js fails"}]}\n```', { cycle: 1, raised });
  assert.strictEqual(borrowed.passed, true);
  assert.strictEqual(borrowed.findings[0].id, null, "the borrowed id is stripped");
  assert.match(borrowed.findings[0].note, /named F1 but describes b\.js, not a\.js — not an upgrade/);
  assert.match(borrowed.findings[0].note, /not introduced by the fix/);
  const folded = gates.applyReviewToLedger(ledger, borrowed, 1);
  assert.deepStrictEqual(folded.map((e) => [e.id, e.file, e.summary, e.status]), [["F1", "a.js", "I think a races", "advisory"], ["F2", "b.js", "b loses data", "advisory"]], "F1 keeps its identity; the new defect is its own entry");
  // Same borrowed id, different file, but introduced by the fix: blocks as
  // the new finding it is, still never as F1.
  const introduced = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"id":"F1","severity":"blocking","file":"b.js","summary":"b loses data","evidence":"node b.test.js fails","introduced_by_fix":true}]}\n```', { cycle: 1, raised });
  assert.deepStrictEqual([introduced.passed, introduced.findings[0].blocking, introduced.findings[0].id], [false, true, null]);
  const next = gates.applyReviewToLedger(ledger, introduced, 1);
  assert.deepStrictEqual(next.map((e) => [e.id, e.file, e.status]), [["F1", "a.js", "advisory"], ["F2", "b.js", "open"]]);
  assert.strictEqual(gates.withLedgerIds(introduced.findings, next, ledger)[0].id, "F2");
  // A ledger entry with NO file cannot be checked and admits the upgrade —
  // with the entry's own summary as its identity.
  const nofile = [{ id: "F1", severity: "blocking", file: "", summary: "something races", blocking: false, status: "advisory", evidence: "", opened: 0, closed: null }];
  const up = gates.parseReviewVerdict('```json\n{"verdict":"changes_requested","findings":[{"id":"F1","severity":"blocking","file":"a.js","summary":"a races","evidence":"node race.js"}]}\n```', { cycle: 1, raised: gates.raisedUndemonstrated(nofile) });
  assert.deepStrictEqual([up.findings[0].blocking, up.findings[0].id, up.findings[0].summary, up.findings[0].restated, up.findings[0].file], [true, "F1", "something races", "a races", "a.js"]);
  const upFolded = gates.applyReviewToLedger(nofile, up, 1);
  assert.deepStrictEqual([upFolded[0].status, upFolded[0].summary, upFolded[0].restated, upFolded[0].file], ["open", "something races", "a races", ""]);
});

// --- the rescue lane (task-spor-factory-rescue-lane) -----------------------

test("a factory's `rescue:` block parses — profile required, attempts bounded 1..3, absent means no lane", () => {
  const body = (payload) => ["```json", JSON.stringify(payload), "```"].join("\n");
  const base = { gates: [{ id: "review", kind: "agent-review", profile: "profile-review", cycles: 1 }] };
  const none = gates.parseFactory(body(base));
  assert.deepStrictEqual(none.errors, []);
  assert.strictEqual(none.factory.rescue, null, "no block, no lane — byte-identical to before");
  const lane = gates.parseFactory(body({ ...base, rescue: { profile: "profile-claude-fable" } }));
  assert.deepStrictEqual(lane.errors, []);
  assert.deepStrictEqual(lane.factory.rescue, { profile: "profile-claude-fable", attempts: 1, awaitMs: 3600000, instructions: "" }, "one attempt by default, followed as long as a review");
  const tuned = gates.parseFactory(body({ ...base, rescue: { profile: "profile-claude-fable", attempts: 9, await_ms: 5000, instructions: "  prefer the smallest fix  " } }));
  assert.deepStrictEqual(tuned.factory.rescue, { profile: "profile-claude-fable", attempts: 3, awaitMs: 5000, instructions: "prefer the smallest fix" }, "attempts capped at 3");
  assert.strictEqual(gates.parseFactory(body({ ...base, rescue: { profile: "p", attempts: 0 } })).factory.rescue.attempts, 1, "…and floored at 1");
  const noProfile = gates.parseFactory(body({ ...base, rescue: { attempts: 1 } }));
  assert.strictEqual(noProfile.factory, null, "a lane with no profile refuses the factory");
  assert.match(noProfile.errors.join("; "), /rescue\.profile is required/);
  const notObject = gates.parseFactory(body({ ...base, rescue: "profile-claude-fable" }));
  assert.strictEqual(notObject.factory, null);
  assert.match(notObject.errors.join("; "), /rescue: must be a JSON object/);
});

test("parseRescueReport reads the structured diagnosis in code — last fence wins, unknown category reads unknown, prose-only is unread but salvaged", () => {
  const r = gates.parseRescueReport(
    "I looked.\n```json\n{\"diagnosis\": \"draft\"}\n```\nMore.\n```json\n{\"diagnosis\": \"the reviewer demanded a refactor the item never asked for\", \"category\": \"Reviewer Drift\", \"fixed\": true, \"filed\": [\"task-tighten-review-instructions\", \"not a valid id\"]}\n```"
  );
  assert.deepStrictEqual(r, { ok: true, diagnosis: "the reviewer demanded a refactor the item never asked for", category: "reviewer-drift", fixed: true, filed: ["task-tighten-review-instructions"] }, "malformed filed ids are dropped, the category normalizes");
  assert.strictEqual(gates.parseRescueReport('{"diagnosis":"x","category":"cosmic-rays","fixed":"yes"}').category, "unknown", "a bare object is accepted; an unknown category is unknown");
  assert.strictEqual(gates.parseRescueReport('{"diagnosis":"x","category":"cosmic-rays","fixed":"yes"}').fixed, true);
  const prose = gates.parseRescueReport("I could not tell what went wrong, the suite is red on main.");
  assert.strictEqual(prose.ok, false);
  assert.strictEqual(prose.category, "unknown");
  assert.match(prose.diagnosis, /suite is red on main/, "the prose tail is kept for the escalation");
  assert.match(prose.error, /no structured diagnosis/);
  const empty = gates.parseRescueReport("");
  assert.deepStrictEqual([empty.ok, empty.diagnosis, empty.error], [false, "", "the rescue left no report"]);
});

// task-spor-review-gate-durable-debt-flag-checklist: the durable-debt table
// is ONE constant rendered into the review, fix and worker prompts, so the
// rows are named the same way everywhere ("row (c)" means the same thing to a
// reviewer, a fixer and a commit message).
test("the durable-debt checklist has the four fixed rows, lettered, and indents as one block", () => {
  assert.deepStrictEqual(
    gates.DURABLE_FLAG_FAILURE_MODES.map((m) => m.key),
    ["write-fails", "clear-before-owe", "check-then-write", "stale-flag"]
  );
  const text = gates.renderDurableFlagChecklist();
  const lines = text.split("\n");
  assert.strictEqual(lines.length, 4);
  assert.match(lines[0], /^\(a\) the flag write itself fails — /);
  assert.match(lines[1], /^\(b\) clear-before-owe ordering and the crash window — /);
  assert.match(lines[2], /^\(c\) the check-then-write race — /);
  assert.match(lines[3], /^\(d\) a stale flag against already-settled state — /);
  for (const l of gates.renderDurableFlagChecklist({ indent: "   " }).split("\n")) assert.match(l, /^   \([a-d]\) /);
  assert.ok(Object.isFrozen(gates.DURABLE_FLAG_FAILURE_MODES), "the table is a contract, not a mutable list");
});
