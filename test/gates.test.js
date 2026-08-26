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
    '```json\n{"verdict": "changes_requested", "findings": [{"severity":"blocking","file":"a.js","summary":"off by one"}]}\n```'
  );
  assert.deepStrictEqual([changes.ok, changes.passed, changes.findings.length], [true, false, 1]);
  assert.match(gates.renderFindings(changes.findings), /\[blocking\] a\.js — off by one/);

  // findings with no verdict word: empty passes, non-empty does not.
  assert.strictEqual(gates.parseReviewVerdict('```json\n{"findings": []}\n```').passed, true);
  assert.strictEqual(gates.parseReviewVerdict('```json\n{"findings": [{"summary":"x"}]}\n```').passed, false);

  // The LAST block wins — a reviewer that quotes the schema before answering.
  const quoted = gates.parseReviewVerdict(
    'I will answer as\n```json\n{"verdict": "pass"}\n```\nand my answer is\n```json\n{"verdict": "changes_requested", "findings": [{"summary":"x"}]}\n```'
  );
  assert.strictEqual(quoted.passed, false);

  // A "pass" that reports its own blocking findings contradicts itself, and the
  // findings win — taking the word over the evidence is the laundering this
  // parser exists to prevent.
  const contradictory = gates.parseReviewVerdict(
    '```json\n{"verdict":"pass","findings":[{"severity":"blocking","file":"a.js","summary":"drops records"}]}\n```'
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

test("cycleDecision retries up to the declared cap, then escalates", () => {
  assert.strictEqual(gates.cycleDecision({ cycles: 2 }, 0), "retry");
  assert.strictEqual(gates.cycleDecision({ cycles: 2 }, 1), "retry");
  assert.strictEqual(gates.cycleDecision({ cycles: 2 }, 2), "escalate");
  // The default is no fix cycle at all: one failure escalates.
  assert.strictEqual(gates.cycleDecision({ cycles: 0 }, 0), "escalate");
  assert.strictEqual(gates.cycleDecision({}, 0), "escalate");
});
