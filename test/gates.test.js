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

// --- definition provenance (task-spor-factory-gate-attestation) --------------
test("parseFactory attaches definition digests that are stable under payload key order and change when a gate changes", () => {
  const body = (payload) => ["```json", JSON.stringify(payload), "```"].join("\n");
  const a = gates.parseFactory(body({ factory: "t", trusted_ref: "main", gates: [{ id: "acc", kind: "command", command: "npm test" }] }), { id: "factory-t" });
  const b = gates.parseFactory(body({ gates: [{ command: "npm test", kind: "command", id: "acc" }], trusted_ref: "main", factory: "t" }), { id: "factory-t" });
  assert.deepStrictEqual(a.errors, []);
  assert.match(a.factory.definition.factory.digest, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(a.factory.definition.factory.digest, b.factory.definition.factory.digest, "key order never changes the digest");
  assert.strictEqual(a.factory.definition.gates.length, 1);
  assert.strictEqual(a.factory.definition.gates[0].id, "acc");
  assert.strictEqual(a.factory.definition.gates[0].source, "inline");
  assert.strictEqual(a.factory.definition.gates[0].digest, b.factory.definition.gates[0].digest);
  assert.strictEqual(a.factory.definition.factory.revision, null, "no node behind a bare payload — the shell stamps revisions");

  const c = gates.parseFactory(body({ factory: "t", trusted_ref: "main", gates: [{ id: "acc", kind: "command", command: "npm run test:all" }] }), { id: "factory-t" });
  assert.notStrictEqual(c.factory.definition.factory.digest, a.factory.definition.factory.digest, "a changed command is a changed definition");
  assert.notStrictEqual(c.factory.definition.gates[0].digest, a.factory.definition.gates[0].digest);

  // An inline gate and the same gate referenced by id digest IDENTICALLY —
  // the runner cannot tell them apart, so neither can the attestation.
  const shared = { id: "acc", kind: "command", command: "npm test" };
  const inline = gates.parseFactory(body({ factory: "t", trusted_ref: "main", gates: [shared] }), { id: "factory-t" });
  const referenced = gates.parseFactory(body({ factory: "t", trusted_ref: "main", gates: [{ ref: "gate-acc" }] }), { id: "factory-t", gateNodes: new Map([["gate-acc", shared]]) });
  assert.deepStrictEqual(referenced.errors, []);
  assert.strictEqual(referenced.factory.definition.gates[0].source, "gate-acc");
  // `source` is provenance the runner never branches on, so it is NOT in the
  // digest: the gate digests are equal, and so are the factory digests (the
  // runtime-effective definition is the same). Provenance still rides beside
  // the digest, and a validator recomputes over the same effective shape.
  assert.match(referenced.factory.definition.gates[0].digest, /^sha256:/);
  assert.strictEqual(referenced.factory.definition.gates[0].digest, inline.factory.definition.gates[0].digest, "inline vs referenced never changes the gate digest");
  assert.strictEqual(referenced.factory.definition.factory.digest, inline.factory.definition.factory.digest, "inline vs referenced never changes the factory digest");
  assert.strictEqual(inline.factory.definition.gates[0].source, "inline");
  assert.strictEqual(gates.definitionDigest(gates.effectiveGate(referenced.factory.gates[0])), referenced.factory.definition.gates[0].digest, "a validator recomputes the gate digest over the effective gate");
  assert.strictEqual(gates.definitionDigest(gates.effectiveFactory(referenced.factory)), referenced.factory.definition.factory.digest, "a validator recomputes the factory digest over the effective factory");

  // The shell's half: revisions ride per node — an inline gate inherits the
  // factory node's, a referenced one gets its own node's.
  gates.stampDefinitionRevisions(referenced.factory, { factory: "f-rev", gates: { "gate-acc": "g-rev" } });
  assert.strictEqual(referenced.factory.definition.factory.revision, "f-rev");
  assert.strictEqual(referenced.factory.definition.gates[0].revision, "g-rev");
  gates.stampDefinitionRevisions(inline.factory, { factory: "f-rev", gates: {} });
  assert.strictEqual(inline.factory.definition.gates[0].revision, "f-rev");
});

test("canonicalJson sorts keys recursively, drops undefined, and definitionDigest is sha256 over it", () => {
  assert.strictEqual(gates.canonicalJson({ b: [3, { z: 1, y: undefined, x: 2 }], a: "s" }), '{"a":"s","b":[3,{"x":2,"z":1}]}');
  assert.strictEqual(gates.definitionDigest({ a: 1, b: 2 }), gates.definitionDigest({ b: 2, a: 1 }));
  assert.match(gates.definitionDigest({}), /^sha256:[0-9a-f]{64}$/);
});
