// The run ATTESTATION (task-spor-factory-gate-attestation): one commit-bound,
// config-checksummed record per gated run, built from the gate pipeline's and
// the integration stage's results. Oracles: the id is deterministic per
// (node, run, attempt); the object carries the swamp-shaped sections a CI
// validate-attestation job checks (subject.commit, gate.allPassed, configIntegrity
// digests, timing); the node validates through the real frontmatter parser; and
// the PR body round-trips the JSON through its markers.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const attestation = require("../lib/shell/attestation.js");
const gates = require("../lib/kernel/gates.js");
const graphLib = require(path.join(__dirname, "..", "lib", "graph.js"));

function factoryOf(payload) {
  const body = ["```json", JSON.stringify(payload), "```"].join("\n");
  const { factory, errors } = gates.parseFactory(body, { id: "factory-test" });
  assert.deepStrictEqual(errors, []);
  gates.stampDefinitionRevisions(factory, { factory: "f00d", gates: {} });
  return factory;
}

const FACTORY = factoryOf({
  factory: "test",
  trusted_ref: "main",
  protected_paths: ["test/**"],
  test_lane_profile: "profile-test-writer",
  gates: [
    { id: "acceptance", kind: "command", command: "npm test" },
    { id: "review", kind: "agent-review", profile: "profile-review" },
  ],
  integration: { target_ref: "main", mode: "propose", command: "npm test" },
});

const ITEM = { node_id: "task-demo", run_id: "run-abcdef12", project: "demo", attempt: 0 };
const HEAD = "headsha0000000000000000000000000000000001";

function gateResult(overrides = {}) {
  const steps = FACTORY.gates.map((g, i) => ({
    gate: g.id, kind: g.kind, verdict: "passed", detail: "ok", fact: `art-gate-${g.id}-demo-runabcde-0000000${i}`, escalated_to: null,
    source: "inline", digest: FACTORY.definition.gates[i].digest, revision: "f00d", head: HEAD, base: "basesha", cycles: 1,
    started_at: new Date(1_700_000_000_000 + i * 1000).toISOString(), finished_at: new Date(1_700_000_000_000 + i * 1000 + 500).toISOString(), duration_ms: 500,
  }));
  return {
    state: "passed", reason: "2 gate(s) passed", gates: steps, facts: steps.map((s) => s.fact),
    head: HEAD, base: "basesha", trusted_ref: "main", trusted_sha: "trustsha", branch: "task-demo", definition: FACTORY.definition,
    ...overrides,
  };
}

test("the attestation id is deterministic per (node, run, attempt) and distinct across attempts", () => {
  const a = attestation.attestationId("task-demo", "run-abcdef12", 0);
  assert.match(a, /^art-attest-demo-runabcde-[0-9a-f]{8}$/);
  assert.strictEqual(a, attestation.attestationId("task-demo", "run-abcdef12", 0));
  assert.notStrictEqual(a, attestation.attestationId("task-demo", "run-abcdef12", 2), "a re-gate attests separately");
  assert.notStrictEqual(a, attestation.attestationId("task-demo", "run-ffffffff", 0));
});

test("a passing run with no integration attests: subject commit = gated head, allPassed, digests, timing", () => {
  const now = () => 1_700_000_010_000;
  const att = attestation.buildAttestationObject({ item: ITEM, factory: FACTORY, gate: gateResult(), environment: { spor_version: "0.0.0-test", host: "box" }, now });
  assert.strictEqual(att.schema, "spor.attestation/1");
  assert.strictEqual(att.passed, true);
  assert.strictEqual(att.subject.commit, HEAD);
  assert.strictEqual(att.subject.branch, "task-demo");
  assert.strictEqual(att.subject.trusted_ref, "main");
  assert.strictEqual(att.subject.trusted_sha, "trustsha");
  assert.strictEqual(att.subject.node, "task-demo");
  assert.strictEqual(att.subject.run, "run-abcdef12");
  assert.strictEqual(att.gate.allPassed, true);
  assert.strictEqual(att.gate.head, HEAD);
  assert.deepStrictEqual(att.gate.steps.map((s) => [s.id, s.verdict, s.passed, s.head]), [
    ["acceptance", "passed", true, HEAD],
    ["review", "passed", true, HEAD],
  ]);
  assert.strictEqual(att.integration, null);
  assert.strictEqual(att.factory.id, "factory-test");
  assert.strictEqual(att.factory.revision, "f00d");
  assert.strictEqual(att.factory.digest, FACTORY.definition.factory.digest);
  assert.strictEqual(att.configIntegrity.factory.digest, FACTORY.definition.factory.digest);
  assert.deepStrictEqual(att.configIntegrity.gates.map((g) => g.id), ["acceptance", "review"]);
  assert.deepStrictEqual(att.configIntegrity.protected_paths, ["test/**"]);
  assert.strictEqual(att.timing.started_at, new Date(1_700_000_000_000).toISOString(), "the earliest step start");
  assert.strictEqual(att.timing.finished_at, new Date(1_700_000_010_000).toISOString());
  assert.strictEqual(att.timing.duration_ms, 10_000);
  assert.strictEqual(att.environment.spor_version, "0.0.0-test");
  assert.strictEqual(att.environment.host, "box");
  // A validator recomputes the digest from the factory node with the kernel's
  // own function — the attestation's digest IS that function's output.
  assert.strictEqual(att.configIntegrity.factory.digest, gates.describeDefinition(FACTORY).factory.digest);
});

test("a failed gate attests NOT passed, and a landed integration binds the commit to the integration head and the landed sha", () => {
  const failed = attestation.buildAttestationObject({
    item: ITEM, factory: FACTORY,
    gate: gateResult({ state: "failed", reason: "gate 'review' failed: 2 finding(s)", gates: gateResult().gates.map((s, i) => (i === 1 ? { ...s, verdict: "failed" } : s)) }),
  });
  assert.strictEqual(failed.passed, false);
  assert.strictEqual(failed.gate.allPassed, false);
  assert.strictEqual(failed.gate.state, "failed");
  assert.match(failed.gate.reason, /review/);

  const landed = attestation.buildAttestationObject({
    item: ITEM, factory: FACTORY, gate: gateResult(),
    integration: { state: "passed", mode: "local", strategy: "merge", target_ref: "main", target_sha: "targetsha", head: HEAD, gated_head: HEAD, head_matches_gated: true, landed_sha: "landedsha", facts: ["art-merge-x"], duration_ms: 5 },
  });
  assert.strictEqual(landed.passed, true);
  assert.strictEqual(landed.subject.commit, HEAD);
  assert.strictEqual(landed.integration.landed_sha, "landedsha");
  assert.strictEqual(landed.integration.head_matches_gated, true);
  assert.strictEqual(landed.integration.target_sha, "targetsha");

  // A head that moved between the gates and the stage is visible, and the
  // subject is the head the STAGE saw (what would have landed), not the
  // gated one — a validator comparing subject.commit against the PR head
  // must see the truth.
  const moved = attestation.buildAttestationObject({
    item: ITEM, factory: FACTORY, gate: gateResult(),
    integration: { state: "failed", mode: "local", head: "movedsha", gated_head: HEAD, landed_sha: null },
  });
  assert.strictEqual(moved.passed, false);
  assert.strictEqual(moved.subject.commit, "movedsha");
  assert.strictEqual(moved.integration.head_matches_gated, false);
  // A parked proposal is not a failure: the gates passed and the PR carries it.
  const parked = attestation.buildAttestationObject({ item: ITEM, factory: FACTORY, gate: gateResult(), integration: { state: "parked", mode: "propose", head: HEAD, gated_head: HEAD } });
  assert.strictEqual(parked.passed, true);
});

test("the attestation node validates through the real frontmatter parser, links every fact, and never resolves", () => {
  const built = attestation.buildAttestationNode({
    item: ITEM, factory: FACTORY, gate: gateResult(),
    integration: { state: "parked", mode: "propose", head: HEAD, gated_head: HEAD, facts: ["art-merge-demo-runabcde-proposed-00000000"], proposal: { number: 42, url: "https://github.com/demo/repo/pull/42" } },
    now: () => 1_700_000_010_000,
  });
  assert.strictEqual(built.id, attestation.attestationId("task-demo", "run-abcdef12", 0));
  const parsed = graphLib.parseFrontmatter(built.markdown, `${built.id}.md`);
  assert.strictEqual(parsed.id, built.id);
  assert.strictEqual(parsed.type, "artifact");
  assert.strictEqual(parsed.project, "demo");
  assert.strictEqual(parsed.gate_head, HEAD);
  assert.strictEqual(parsed.factory_digest, FACTORY.definition.factory.digest);
  assert.match(parsed.summary, /Attestation for task-demo run runabcde: passed at commit headsha00000/);
  const edges = parsed.edges.map((e) => [e.type, e.to]);
  assert.deepStrictEqual(edges, [
    ["relates-to", "task-demo"],
    ["relates-to", "art-gate-acceptance-demo-runabcde-00000000"],
    ["relates-to", "art-gate-review-demo-runabcde-00000001"],
    ["relates-to", "art-merge-demo-runabcde-proposed-00000000"],
  ]);
  assert.doesNotMatch(built.markdown, /type: resolves/, "an attestation records, it never retires");
  // The JSON in the body is the attestation itself, byte-equal to the object.
  const m = built.markdown.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(m, "the body carries the attestation as fenced JSON");
  assert.deepStrictEqual(JSON.parse(m[1]), built.attestation);
  assert.match(built.markdown, /definitionDigest/, "the body tells a validator how to recompute the checksum");
});

test("the PR body carries the attestation between markers, and extractPrAttestation reads it back", () => {
  const att = attestation.buildAttestationObject({
    item: ITEM, factory: FACTORY, gate: gateResult(),
    integration: { mode: "propose", state: "proposing", target_ref: "main", target_sha: "targetsha", head: HEAD, gated_head: HEAD, candidate: { base: "targetsha", sha: "candsha", suite: "passed", command: "npm test" } },
  });
  const body = attestation.renderPrBody({ attestation: att, branch: "task-demo", base: "main" });
  assert.match(body, /^Opened by the spor work integration stage/);
  assert.match(body, new RegExp(`commit \`${HEAD}\``));
  assert.match(body, /gates all passed/);
  assert.match(body, /- `acceptance` \(command\) — passed at `headsha00000`/);
  assert.match(body, /Candidate suite \(`npm test`\) passed on merge\(`main` at `targetsha`, `headsha00000`\) → `candsha`/);
  assert.match(body, /subject\.commit.*must equal the PR head/);
  assert.ok(body.indexOf(attestation.PR_BEGIN) < body.indexOf(attestation.PR_END));
  const back = attestation.extractPrAttestation(body);
  assert.deepStrictEqual(back, att, "what CI reads off the PR is exactly what was attested");
  // Surrounding prose (a reviewer's edit above or below) does not break it.
  assert.deepStrictEqual(attestation.extractPrAttestation(`Reviewer notes.\n\n${body}\n\nMore notes.`), att);
  // A head that is NOT the gated head is called out in prose, not just in the JSON.
  const moved = attestation.buildAttestationObject({ item: ITEM, factory: FACTORY, gate: gateResult(), integration: { mode: "propose", head: "movedsha", gated_head: HEAD } });
  assert.match(attestation.renderPrBody({ attestation: moved, branch: "b", base: "main" }), /the proposed head is not the head the gates judged/);
  // Absent or mangled markers/JSON read as nothing, never as a pass.
  assert.strictEqual(attestation.extractPrAttestation("no attestation here"), null);
  assert.strictEqual(attestation.extractPrAttestation(`${attestation.PR_BEGIN}\n\`\`\`json\n{not json\n\`\`\`\n${attestation.PR_END}`), null);
  assert.strictEqual(attestation.extractPrAttestation(`${attestation.PR_BEGIN}\n\`\`\`json\n{"schema":"other/1"}\n\`\`\`\n${attestation.PR_END}`), null);
});

// ---------------------------------------- head consistency (review findings 1 and 3) --
test("an attestation whose steps did not all judge the subject commit is NOT allPassed — and an unknown commit never passes", () => {
  const other = "head9999999999999999999999999999999999999";
  const gate = gateResult();
  gate.gates[0].head = other; // gate A passed at an earlier head; a fix cycle moved HEAD before gate B
  const att = attestation.buildAttestationObject({ item: ITEM, factory: FACTORY, gate, integration: null, now: () => 1_700_000_005_000 });
  assert.strictEqual(att.gate.state, "passed");
  assert.strictEqual(att.gate.head_consistent, false);
  assert.strictEqual(att.gate.allPassed, false, "a pass at a head other than the subject commit is not a pass for the subject commit");
  assert.strictEqual(att.passed, false);
  const node = attestation.buildAttestationNode({ item: ITEM, factory: FACTORY, gate, integration: null, now: () => 1_700_000_005_000 });
  assert.match(node.markdown, /gates passed but not all at the subject commit/);

  const unknown = attestation.buildAttestationObject({ item: ITEM, factory: FACTORY, gate: gateResult({ head: null, gates: gateResult().gates.map((s) => ({ ...s, head: null })) }), integration: null, now: () => 1_700_000_005_000 });
  assert.strictEqual(unknown.subject.commit, null);
  assert.strictEqual(unknown.gate.allPassed, false, "no commit, no attestation of it");
  assert.strictEqual(unknown.passed, false);
});

test("an integration head that is not the gated head fails the attestation even when the stage reports passed", () => {
  const att = attestation.buildAttestationObject({
    item: ITEM, factory: FACTORY, gate: gateResult(),
    integration: { mode: "local", state: "passed", head: "otherhead", gated_head: HEAD, landed_sha: "landed", facts: [] },
    now: () => 1_700_000_005_000,
  });
  assert.strictEqual(att.integration.head_matches_gated, false);
  assert.strictEqual(att.gate.allPassed, true);
  assert.strictEqual(att.passed, false);
  // A stage that RE-GATED a moved head reports that head as gated_head — equality is against it.
  const regated = attestation.buildAttestationObject({
    item: ITEM, factory: FACTORY, gate: gateResult({ head: "movedhead", gates: gateResult().gates.map((s) => ({ ...s, head: "movedhead" })) }),
    integration: { mode: "local", state: "passed", head: "movedhead", gated_head: "movedhead", landed_sha: "landed", facts: [] },
    now: () => 1_700_000_005_000,
  });
  assert.strictEqual(regated.passed, true);
  assert.strictEqual(regated.subject.commit, "movedhead");
});

// ------------------------------------------------ the node body cap (review finding 4) --
// A large factory's attestation used to be byte-truncated AFTER serialization,
// leaving a cut JSON block no validator can parse. The rendering now steps
// down (pretty -> compact -> thinned) until it fits; the JSON is always whole.
test("a large factory's attestation fits the node body cap with WHOLE JSON — thinned, never cut", () => {
  const gateRunner = require("../lib/shell/gate-runner.js");
  const big = factoryOf({
    factory: "big", trusted_ref: "main",
    gates: Array.from({ length: 60 }, (_, i) => ({ id: `gate-number-${i}-with-a-long-name`, kind: "command", command: `npm run suite-${i} -- --with --several --flags` })),
  });
  const steps = big.gates.map((g, i) => ({
    gate: g.id, kind: g.kind, verdict: "passed", detail: `\`${g.command}\` passed against main's copy of the protected paths, with a long detail line ${"x".repeat(80)}`,
    fact: `art-gate-${g.id.slice(0, 24)}-demo-runabcde-${String(i).padStart(8, "0")}`, escalated_to: null, source: "inline", digest: big.definition.gates[i].digest, revision: "f00d",
    head: HEAD, base: "basesha", cycles: 1, started_at: new Date(1_700_000_000_000 + i * 1000).toISOString(), finished_at: new Date(1_700_000_000_000 + i * 1000 + 500).toISOString(), duration_ms: 500,
  }));
  const gate = { state: "passed", reason: "60 gate(s) passed", gates: steps, facts: steps.map((s) => s.fact), head: HEAD, base: "basesha", trusted_ref: "main", trusted_sha: "trustsha", branch: "task-demo", definition: big.definition };
  const node = attestation.buildAttestationNode({ item: ITEM, factory: big, gate, integration: null, now: () => 1_700_000_100_000 });
  assert.ok(Buffer.byteLength(node.markdown, "utf8") <= gateRunner.NODE_BODY_CAP_BYTES - 512, `the node body is within the cap (${Buffer.byteLength(node.markdown, "utf8")} bytes)`);
  const block = /```json\n([\s\S]*?)\n```/.exec(node.markdown);
  assert.ok(block, "the JSON block is intact");
  const parsed = JSON.parse(block[1]);
  assert.strictEqual(parsed.schema, attestation.SCHEMA);
  assert.strictEqual(parsed.passed, true);
  assert.strictEqual(parsed.subject.commit, HEAD);
  assert.strictEqual(parsed.gate.allPassed, true);
  assert.strictEqual(parsed.configIntegrity.factory.digest, big.definition.factory.digest);
  assert.ok(parsed.gate.steps.length === 60 || parsed.gate.steps_elided === 60, "the steps are carried or their count is");
  assert.match(node.markdown, /This is an attestation, not a resolution/, "the trailing prose survived — nothing was cut");
  // The full object is untouched: the node thins only what it renders.
  assert.strictEqual(node.attestation.gate.steps.length, 60);
  assert.strictEqual(node.attestation.gate.steps[0].detail.length > 80, true);
  // A small factory still renders the pretty, complete JSON.
  const small = attestation.buildAttestationNode({ item: ITEM, factory: FACTORY, gate: gateResult(), integration: null, now: () => 1_700_000_100_000 });
  assert.match(small.markdown, /"schema": "spor\.attestation\/1"/, "pretty-printed when it fits");
});

// --- binding: digest, signature, verification (cross-model review, finding 2) --
//
// A PR body is mutable text; the JSON in it is evidence only through what
// binds it: the digest (equal to the runner-written graph artifact's) and,
// when the pipeline holds a key, the HMAC signature.
test("every attestation carries a digest over its bound core that survives the node-body ladder, and a key adds an HMAC signature", () => {
  const unsigned = attestation.buildAttestationObject({ item: ITEM, factory: FACTORY, gate: gateResult() });
  assert.match(unsigned.digest, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(unsigned.signature, undefined, "no key, no signature");
  assert.strictEqual(attestation.attestationDigest(unsigned), unsigned.digest, "the digest recomputes over the object's own core");
  // Fields OUTSIDE the core (free text, the box the run happened on) do not move it.
  const withHost = attestation.buildAttestationObject({ item: ITEM, factory: FACTORY, gate: gateResult(), environment: { host: "other-box", worker: "w2" }, now: () => Date.parse(unsigned.issued_at) });
  assert.strictEqual(withHost.digest, unsigned.digest, "environment.host/worker are outside the bound core");
  // Fields INSIDE it do: a different commit, a different verdict, a different factory digest.
  const otherHead = attestation.buildAttestationObject({ item: ITEM, factory: FACTORY, gate: gateResult({ head: "otherhead00000000000000000000000000000002", gates: gateResult().gates.map((g) => ({ ...g, head: "otherhead00000000000000000000000000000002" })) }), now: () => Date.parse(unsigned.issued_at) });
  assert.notStrictEqual(otherHead.digest, unsigned.digest);
  const failed = attestation.buildAttestationObject({ item: ITEM, factory: FACTORY, gate: gateResult({ state: "failed", gates: gateResult().gates.map((g) => ({ ...g, verdict: "failed" })) }), now: () => Date.parse(unsigned.issued_at) });
  assert.notStrictEqual(failed.digest, unsigned.digest);

  const signed = attestation.buildAttestationObject({ item: ITEM, factory: FACTORY, gate: gateResult(), signing: { key: "team-secret", keyId: "ci-2026" }, now: () => Date.parse(unsigned.issued_at) });
  assert.strictEqual(signed.digest, unsigned.digest, "signing does not change the digest");
  assert.deepStrictEqual(Object.keys(signed.signature).sort(), ["alg", "key_id", "value"]);
  assert.strictEqual(signed.signature.alg, attestation.SIGNATURE_ALG);
  assert.strictEqual(signed.signature.key_id, "ci-2026");
  assert.match(signed.signature.value, /^[0-9a-f]{64}$/);

  // The node-body ladder thins the JSON but never the bound core: a node
  // rendered at the floor still carries the SAME digest field, and the core
  // recomputed from the thinned copy still matches it.
  const many = factoryOf({ factory: "big", trusted_ref: "main", gates: Array.from({ length: 40 }, (_, i) => ({ id: `gate-${i}`, kind: "command", command: `npm run check-${i}` })) });
  const bigGate = { ...gateResult(), gates: many.gates.map((g, i) => ({ gate: g.id, kind: g.kind, verdict: "passed", detail: "x".repeat(200), fact: `art-gate-${g.id}-demo-runabcde-${String(i).padStart(8, "0")}`, source: "inline", digest: many.definition.gates[i].digest, revision: "f00d", head: HEAD, base: "basesha", cycles: 1 })), facts: [], definition: many.definition };
  const node = attestation.buildAttestationNode({ item: ITEM, factory: many, gate: bigGate });
  const inNode = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(node.markdown)[1]);
  assert.strictEqual(inNode.digest, node.attestation.digest);
  assert.strictEqual(attestation.attestationDigest(inNode), node.attestation.digest, "the thinned graph copy recomputes to the same digest");
  assert.match(node.markdown, new RegExp(`^attestation_digest: ${node.attestation.digest}$`, "m"));
});

test("verifyAttestation fails closed: a tampered body, a wrong key, a missing signature under a key, a graph copy that disagrees, a stale or foreign commit", () => {
  const issued = Date.parse("2026-09-02T12:00:00.000Z");
  const now = () => issued + 60_000;
  const att = attestation.buildAttestationObject({ item: ITEM, factory: FACTORY, gate: gateResult(), signing: { key: "k", keyId: "ci" }, now: () => issued });
  const signed = att;
  const trusted = JSON.parse(JSON.stringify(att));
  const ok = attestation.verifyAttestation(att, { key: "k", trusted, commit: HEAD, maxAgeMs: 3_600_000, factoryDigest: FACTORY.definition.factory.digest, now });
  assert.strictEqual(ok.ok, true, ok.reason);
  assert.deepStrictEqual(ok.checks.map((c) => c.check), ["schema", "digest", "signature", "trusted", "passed", "commit", "fresh", "config"]);

  // Tampered: a PR author flips `passed` in the body. The digest no longer
  // matches, the signature no longer matches, and the graph copy disagrees.
  const forged = JSON.parse(JSON.stringify(att));
  forged.gate.steps[1].verdict = "passed";
  forged.subject.commit = "attackerhead000000000000000000000000000000";
  const bad = attestation.verifyAttestation(forged, { key: "k", trusted, commit: "attackerhead000000000000000000000000000000", now });
  assert.strictEqual(bad.ok, false);
  assert.deepStrictEqual(bad.checks.filter((c) => !c.ok).map((c) => c.check), ["digest", "signature"]);
  // ...and re-binding it (recomputing the digest) still cannot make it the graph's copy or sign it.
  const rebound = attestation.bindAttestation(JSON.parse(JSON.stringify(forged)));
  const bad2 = attestation.verifyAttestation(rebound, { key: "k", trusted, now });
  assert.deepStrictEqual(bad2.checks.filter((c) => !c.ok).map((c) => c.check), ["signature", "trusted"]);
  assert.match(bad2.reason, /unsigned|does not verify/);
  assert.match(bad2.reason, /carries digest/);

  // Wrong key, wrong key id, signature required but absent.
  assert.strictEqual(attestation.verifyAttestation(att, { key: "not-k", now }).checks.find((c) => c.check === "signature").ok, false);
  assert.match(attestation.verifyAttestation(att, { key: "k", keyId: "other", now }).reason, /signed with key 'ci', not 'other'/);
  const unsigned = attestation.buildAttestationObject({ item: ITEM, factory: FACTORY, gate: gateResult(), now: () => issued });
  assert.match(attestation.verifyAttestation(unsigned, { key: "k", now }).reason, /is unsigned/);
  assert.match(attestation.verifyAttestation(unsigned, { requireSignature: true, now }).reason, /signature is required/);
  // No key and no graph copy: the digest alone is self-authored, so this is
  // NOT a pass — verification without an anchor fails closed.
  const anchorless = attestation.verifyAttestation(unsigned, { now });
  assert.strictEqual(anchorless.ok, false, "no anchor, no pass");
  assert.match(anchorless.reason, /no trust anchor/);
  assert.strictEqual(attestation.verifyAttestation(unsigned, { trusted: JSON.parse(JSON.stringify(unsigned)), now }).ok, true, "the graph copy alone is an anchor");
  assert.strictEqual(attestation.verifyAttestation(signed, { key: "k", now }).ok, true, "the key alone is an anchor");
  assert.match(attestation.verifyAttestation(unsigned, { requireTrusted: true, now }).reason, /graph artifact copy is required/);

  // Graph copy under a different id, or a different digest.
  assert.match(attestation.verifyAttestation(att, { trusted: { ...trusted, id: "art-attest-other" }, now }).reason, /graph artifact is art-attest-other/);
  // Commit, freshness, config.
  assert.match(attestation.verifyAttestation(att, { commit: "deadbeef", now }).reason, /subject\.commit is headsha.*expected deadbeef/);
  assert.match(attestation.verifyAttestation(att, { maxAgeMs: 1000, now }).reason, /older than 1s/);
  assert.match(attestation.verifyAttestation(att, { maxAgeMs: 1000, now: () => issued - 5000 }).reason, /in the future/);
  assert.match(attestation.verifyAttestation(att, { factoryDigest: "sha256:ffff", now }).reason, /factory digest is sha256:.*expected sha256:ffff/);
  // A failed attestation never verifies, whatever else is right.
  const failed = attestation.buildAttestationObject({ item: ITEM, factory: FACTORY, gate: gateResult({ state: "failed" }), now: () => issued });
  assert.match(attestation.verifyAttestation(failed, { now }).reason, /passed is false/);
  // Wrong schema, no object.
  assert.match(attestation.verifyAttestation({ ...att, schema: "other/9" }, { now }).reason, /schema 'other\/9'/);
  assert.strictEqual(attestation.verifyAttestation(null).ok, false);
});

// Cross-model review, major finding 3: the size ladder's floor was built but
// never measured, and `configIntegrity.protected_paths` rode in the bound core
// unbounded — a factory protecting a few hundred globs produced a node over
// the cap that the graph refused, silently losing the attestation. The paths
// are now bound by count + digest, thinned like the steps, and the floor is
// checked.
test("a factory protecting hundreds of paths still fits the node body cap — the paths are bound by digest, and the thinned copy recomputes it", () => {
  const gateRunner = require("../lib/shell/gate-runner.js");
  const paths = Array.from({ length: 400 }, (_, i) => `packages/service-${i}/test/**/*.spec.js`);
  const wide = { ...FACTORY, protectedPaths: paths };
  const node = attestation.buildAttestationNode({ item: ITEM, factory: wide, gate: gateResult(), integration: null, now: () => 1_700_000_100_000 });
  const cap = gateRunner.NODE_BODY_CAP_BYTES - 512;
  assert.ok(Buffer.byteLength(node.markdown, "utf8") <= cap, `within the cap (${Buffer.byteLength(node.markdown, "utf8")} bytes)`);
  const inNode = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(node.markdown)[1]);
  assert.strictEqual(inNode.digest, node.attestation.digest);
  assert.strictEqual(attestation.attestationDigest(inNode), node.attestation.digest, "the thinned copy (paths elided) recomputes to the same digest");
  assert.strictEqual(inNode.configIntegrity.protected_paths_count, 400);
  assert.match(inNode.configIntegrity.protected_paths_digest, /^[0-9a-f]{64}$/);
  // The paths ARE bound: a copy that adds or drops one fails the digest.
  const full = node.attestation;
  assert.deepStrictEqual(full.configIntegrity.protected_paths.length, 400);
  const tampered = JSON.parse(JSON.stringify(full));
  tampered.configIntegrity.protected_paths = tampered.configIntegrity.protected_paths.slice(1);
  assert.notStrictEqual(attestation.attestationDigest(tampered), full.digest, "dropping a protected path moves the digest");
  const narrow = attestation.buildAttestationObject({ item: ITEM, factory: { ...FACTORY, protectedPaths: ["test/**"] }, gate: gateResult(), now: () => 1_700_000_100_000 });
  assert.notStrictEqual(narrow.digest, attestation.buildAttestationObject({ item: ITEM, factory: wide, gate: gateResult(), now: () => 1_700_000_100_000 }).digest);
  // The floor is checked, not assumed: an item whose identity alone cannot fit is refused loudly, never rendered over the cap.
  const huge = { node_id: `task-${"x".repeat(9000)}`, run_id: "run-abcdef12", project: "demo", attempt: 0 };
  assert.throws(() => attestation.buildAttestationNode({ item: huge, factory: wide, gate: gateResult(), integration: null }), /does not fit the node body cap even at its floor/);
});

test("the PR body names the graph artifact and the digest it is bound to, and says the text alone is not evidence", () => {
  const att = attestation.buildAttestationObject({ item: ITEM, factory: FACTORY, gate: gateResult(), signing: { key: "k", keyId: "ci" } });
  const body = attestation.renderPrBody({ attestation: att, branch: "task-demo", base: "main" });
  assert.match(body, /this text is not evidence by itself/);
  assert.match(body, new RegExp(`spor get ${att.id}`));
  assert.match(body, new RegExp(att.digest));
  assert.match(body, /verify the `signature` \(hmac-sha256, key `ci`/);
  assert.match(body, /spor attestation verify --pr-body/);
  const back = attestation.extractPrAttestation(body);
  assert.strictEqual(back.digest, att.digest);
  assert.deepStrictEqual(back.signature, att.signature);
  assert.strictEqual(attestation.verifyAttestation(back, { key: "k", trusted: att }).ok, true);
});

// The signing key is a SECRET: it resolves from env / the user config, never
// from a committable repo `.spor.json` (a teammate's PR must not be able to
// set the key the pipeline signs with).
test("attestation.signingKey is stripped from a repo .spor.json but resolves from env and the user config", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const { loadConfig } = require("../lib/config.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-attest-cfg-"));
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".spor.json"), JSON.stringify({ enabled: true, attestation: { signingKey: "from-the-repo", keyId: "repo-key" } }));
  const warned = [];
  const viaRepo = loadConfig({ cwd: repo, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home }, warn: (m) => warned.push(m) });
  assert.strictEqual(viaRepo.get("attestation.signingKey", null), null, "a repo .spor.json cannot set the signing key");
  assert.strictEqual(viaRepo.get("attestation.keyId", null), "repo-key", "the key id is not a secret and stays configurable per repo");
  const viaEnv = loadConfig({ cwd: repo, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ATTESTATION_KEY: "from-env", SPOR_ATTESTATION_KEY_ID: "ci" } });
  assert.strictEqual(viaEnv.get("attestation.signingKey"), "from-env");
  assert.strictEqual(viaEnv.get("attestation.keyId"), "ci");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ attestation: { signingKey: "from-user-config" } }));
  const viaUser = loadConfig({ cwd: repo, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  assert.strictEqual(viaUser.get("attestation.signingKey"), "from-user-config");
});

// -- blocking finding 1 (cross-model review): the candidate-suite evidence is
// part of the BOUND core — a validator trusting a propose-mode PR is trusting
// "merge(target, head) was green under <command>", so that block must be as
// tamper-evident as the verdicts.
test("the bound core covers the integration candidate evidence and proposal identity — editing any of it fails the digest", () => {
  const integration = {
    state: "parked", mode: "propose", strategy: "merge", target_ref: "main", target_sha: "targetsha", head: HEAD, gated_head: HEAD, head_matches_gated: true,
    candidate: { base: "targetsha", sha: "candsha", suite: "passed", command: "npm test" },
    proposal: { number: 42, url: "https://github.com/demo/repo/pull/42", repo: "demo/repo", branch: "task-demo" },
  };
  const att = attestation.buildAttestationObject({ item: ITEM, factory: FACTORY, gate: gateResult(), integration, signing: { key: "k", keyId: "ci" } });
  assert.strictEqual(attestation.verifyAttestation(att, { key: "k" }).ok, true);
  const core = attestation.attestationCore(att);
  assert.deepStrictEqual(core.integration.candidate, { base: "targetsha", sha: "candsha", suite: "passed", command: "npm test" });
  assert.deepStrictEqual(core.integration.proposal, { number: 42, repo: "demo/repo", branch: "task-demo", url: "https://github.com/demo/repo/pull/42" });
  assert.strictEqual(core.integration.target_sha, "targetsha");
  assert.strictEqual(core.integration.strategy, "merge");
  const tampered = (mutate) => {
    const copy = JSON.parse(JSON.stringify(att));
    mutate(copy);
    return attestation.verifyAttestation(copy, { key: "k" });
  };
  for (const [label, mutate] of [
    ["suite verdict", (c) => { c.integration.candidate.suite = "failed"; }],
    ["candidate command", (c) => { c.integration.candidate.command = "true"; }],
    ["candidate base", (c) => { c.integration.candidate.base = "othersha"; }],
    ["candidate sha", (c) => { c.integration.candidate.sha = "othersha"; }],
    ["candidate block removed", (c) => { c.integration.candidate = null; }],
    ["target sha", (c) => { c.integration.target_sha = "othersha"; }],
    ["proposal number", (c) => { c.integration.proposal.number = 43; }],
    ["proposal repo", (c) => { c.integration.proposal.repo = "evil/repo"; }],
  ]) {
    const v = tampered(mutate);
    assert.strictEqual(v.ok, false, `${label}: a tampered copy must fail`);
    assert.ok(v.checks.find((c) => c.check === "digest" && !c.ok), `${label}: the digest check catches it`);
    assert.ok(v.checks.find((c) => c.check === "signature" && !c.ok), `${label}: and so does the signature`);
  }
  // ...and the node-body ladder's thinnest rung still carries the whole bound
  // block, so a graph copy reproduces the digest its PR copy was bound to.
  const big = factoryOf({
    factory: "big", trusted_ref: "main",
    gates: Array.from({ length: 40 }, (_, i) => ({ id: `g${i}`, kind: "command", command: `npm run t${i}` })),
    integration: { target_ref: "main", mode: "propose", command: "npm test" },
  });
  const steps = big.gates.map((g, i) => ({ gate: g.id, kind: g.kind, verdict: "passed", detail: "x".repeat(200), fact: `art-gate-${g.id}-demo-runabcde-${String(i).padStart(8, "0")}`, source: "inline", digest: big.definition.gates[i].digest, head: HEAD, base: "b" }));
  const node = attestation.buildAttestationNode({ item: ITEM, factory: big, gate: { state: "passed", gates: steps, facts: steps.map((s) => s.fact), head: HEAD, definition: big.definition }, integration, now: () => 1_700_000_100_000 });
  const json = node.markdown.slice(node.markdown.indexOf("```json") + 7, node.markdown.lastIndexOf("```"));
  const thinned = JSON.parse(json);
  assert.ok(thinned.abridged, "the fixture is big enough to reach the thinned rung");
  assert.deepStrictEqual(thinned.integration.candidate, integration.candidate);
  assert.strictEqual(thinned.integration.proposal.number, 42);
  assert.strictEqual(attestation.attestationDigest(thinned), node.attestation.digest, "the thinned graph copy reproduces the bound digest");
});
