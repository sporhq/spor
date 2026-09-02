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
