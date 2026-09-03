// factory-skill.test.js — the /spor:factory skill's DRY RUN
// (task-spor-factory-builder-skill, derived-from dec-spor-software-factory-
// substrate).
//
// The skill is a conversational compiler: an operator interview in, a factory
// definition as graph DATA out. That output half is deterministic, so it is
// pinned here without an LLM harness — skills/factory/fixtures/ carries a
// sample interview transcript and the exact node set a correct compilation of
// it emits, and this suite replays the emission the way the runner would read
// it back:
//
//   - the candidate schemas are adopted into a SCRATCH graph through the real
//     `spor schema adopt --activate` (never the live home), the fixture nodes
//     are copied in, and the real `spor validate` lints them;
//   - the emitted factory is parsed by the RUNNER's own vocabulary
//     (lib/kernel/gates.js parseFactory), resolving the referenced `type: gate`
//     node exactly as loadFactoryDefinition does in bin/spor.js.
//
// The properties worth pinning are the ones a worker would otherwise discover
// at start-up, where "the factory does not validate" costs a refused worker: a
// dangling gate reference, a routed profile that does not exist, a protected
// path with no lane to route to, a human gate naming an undeclared risk class.
// And the one the skill's whole premise rests on: a profile it emits carries a
// harness NAME and never what a machine executes.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "spor.js");
const SKILL_DIR = path.join(ROOT, "skills", "factory");
const FIXTURE_NODES = path.join(SKILL_DIR, "fixtures", "nodes");
const gates = require("../lib/kernel/gates.js");
const graphLib = require("../lib/graph.js");

// Bare env with no SPOR_*/SUBSTRATE_* leakage — a configured dev box must never
// flip these writes to remote or point them at the live graph home.
function bare(home) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  env.SPOR_HOME = home;
  env.XDG_CONFIG_HOME = home;
  return env;
}

function run(home, args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: home, env: bare(home) });
}

function fixtureFiles() {
  return fs.readdirSync(FIXTURE_NODES).filter((f) => f.endsWith(".md")).sort();
}

function parseFixture(file) {
  const raw = fs.readFileSync(path.join(FIXTURE_NODES, file), "utf8");
  return { raw, node: graphLib.parseFrontmatter(raw, file) };
}

function nodesById() {
  const byId = new Map();
  for (const f of fixtureFiles()) {
    const { raw, node } = parseFixture(f);
    byId.set(node.id, { ...node, raw, file: f });
  }
  return byId;
}

// The emitted factory, resolved the way bin/spor.js's loadFactoryDefinition
// does: fetch every referenced `type: gate` node's payload, then parse.
function resolveEmittedFactory() {
  const byId = nodesById();
  const factories = [...byId.values()].filter((n) => n.type === "factory");
  assert.strictEqual(factories.length, 1, "the fixture emits exactly one factory definition");
  const def = factories[0];
  const gateNodes = new Map();
  for (const ref of gates.factoryRefs(def.body || "")) {
    const gn = byId.get(ref);
    if (!gn) continue; // parseFactory reports the missing reference itself
    assert.strictEqual(gn.type, "gate", `${ref} must be a 'type: gate' node`);
    const payload = gates.fencedJson(gn.body || "");
    assert.ok(payload.ok, `${ref}: ${payload.error || ""}`);
    gateNodes.set(ref, payload.payload);
  }
  // The node's own repo stamp is the default repo scope, exactly as
  // loadFactoryDefinition passes it (parseFrontmatter folds `repo:` into
  // `.project`, the canonical field every consumer keys on).
  return { byId, def, ...gates.parseFactory(def.body || "", { gateNodes, id: def.id, project: def.project || null }) };
}

test("the skill is registered like the other spor skills", () => {
  const raw = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "SKILL.md needs frontmatter");
  assert.match(m[1], /^name: factory$/m);
  assert.match(m[1], /^description: .{80,}/m);
  for (const ref of ["interview.md", "emitting.md", "maintenance.md"]) {
    assert.ok(fs.existsSync(path.join(SKILL_DIR, "references", ref)), `references/${ref} exists`);
    assert.ok(raw.includes(ref), `SKILL.md routes to references/${ref}`);
  }
  // The line the whole skill rests on, stated IN the skill (an acceptance
  // criterion of task-spor-factory-builder-skill): it authors data, and the
  // runner enforces.
  assert.match(raw, /only ever authors data/i);
  assert.match(raw, /never runs a gate/i);
});

test("the emitted node set validates as a graph, through the real CLI", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-factory-skill-"));
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });

  // The adoption step the skill documents: `factory`/`gate` ship as CANDIDATES,
  // so a graph that has not adopted them does not know the types at all.
  for (const id of ["schema-factory", "schema-gate"]) {
    const r = run(home, ["schema", "adopt", id, "--activate"]);
    assert.strictEqual(r.status, 0, `${id} adopt failed: ${r.stderr}`);
  }
  for (const f of fixtureFiles()) {
    fs.copyFileSync(path.join(FIXTURE_NODES, f), path.join(home, "nodes", f));
  }

  const r = run(home, ["validate"]);
  const out = `${r.stdout}${r.stderr}`;
  assert.strictEqual(r.status, 0, `spor validate failed:\n${out}`);
  // The adopted schema nodes carry edges into the real spor graph, which are
  // legitimately dangling here — but nothing the FIXTURE emitted may warn.
  for (const line of out.split("\n")) {
    if (!/warning|error/i.test(line)) continue;
    for (const f of fixtureFiles()) {
      assert.ok(!line.includes(f), `emitted node warned: ${line.trim()}`);
    }
  }
  assert.ok(!/unknown type/.test(out), `an emitted type was not registered:\n${out}`);
});

test("the emitted factory parses with the runner's own vocabulary", () => {
  const { factory, errors } = resolveEmittedFactory();
  assert.deepStrictEqual(errors, [], "a factory that does not validate refuses to start the worker");
  assert.strictEqual(factory.trustedRef, "main");
  assert.deepStrictEqual(
    factory.gates.map((g) => [g.id, g.kind]),
    [["acceptance", "command"], ["adversarial-review", "agent-review"], ["payments-approval", "human"]],
    "gates are ORDERED: the cheap deterministic check first, the person last"
  );
  // A referenced gate is unwrapped into exactly the object an inline one would
  // have been, with keys beside the `ref` overriding it.
  const review = factory.gates.find((g) => g.kind === "agent-review");
  assert.strictEqual(review.source, "gate-adversarial-review", "provenance is the one visible difference");
  assert.strictEqual(review.cycles, 1, "the factory's `cycles` overrides the shared gate's own");
  assert.strictEqual(review.profile, "profile-codex-review");
});

test("the emitted factory is stamped `repo:` and that stamp is its default repo scope", () => {
  // The stamp is load-bearing: with no `repos` in the payload it is the ONLY
  // thing bounding which items a gated worker may judge
  // (dec-spor-factory-declares-the-repos-it-judges), so the skill must emit
  // the current `repo:` spelling rather than the legacy `project:` one.
  for (const f of fixtureFiles()) {
    const { raw } = parseFixture(f);
    assert.match(raw, /^repo: acme-checkout$/m, `${f} carries the repo: stamp`);
    assert.doesNotMatch(raw, /^project:/m, `${f} does not use the legacy project: key`);
  }
  const { factory, errors } = resolveEmittedFactory();
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(factory.repos, ["acme-checkout"], "the stamp becomes the default repo scope");
  assert.ok(gates.inRepoScope("acme-checkout", gates.repoScope(factory.repos)));
  assert.ok(!gates.inRepoScope("acme-billing", gates.repoScope(factory.repos)), "a sibling repo's items are out of scope");
});

test("the emitted integration block parses with the runner's own vocabulary", () => {
  // The skill's whole integration-interview payoff: the block it teaches an
  // operator to answer for (task-spor-factory-skill-integration-block) must be
  // exactly what lib/kernel/gates.js parseIntegration accepts, never a shape
  // that merely looks right.
  const { factory } = resolveEmittedFactory();
  assert.ok(factory.integration, "the fixture's Q7 answer ('just ship it') emits an integration block");
  assert.deepStrictEqual(factory.integration, {
    targetRef: "main",
    mode: "local",
    command: "npm test",
    strategy: "merge",
    serialize: "repo",
    cycles: 1,
    timeoutMs: 900000,
  });
  // mode: propose now parses (task-spor-integration-propose-mode landed PR-
  // landing via gh) — the skill's emitted vocabulary must match the runner's.
  const { integration, errors } = gates.parseIntegration({ integration: { mode: "propose", command: "npm test" } });
  assert.deepStrictEqual(errors, [], "propose mode is a live, parseable integration mode");
  assert.strictEqual(integration.mode, "propose");
});

test("nothing the skill emitted dangles: every ref and every routed profile exists", () => {
  const { byId, factory } = resolveEmittedFactory();
  const have = (id) => byId.has(id);
  assert.ok(have(factory.testLaneProfile), "protected paths route to a lane that exists");
  for (const g of factory.gates) {
    if (g.kind === "agent-review") assert.ok(have(g.profile), `${g.id} routes to a profile that exists`);
    if (g.source !== "inline") assert.ok(have(g.source), `${g.id} references a gate node that exists`);
  }
  for (const id of [factory.testLaneProfile, ...factory.gates.filter((g) => g.profile).map((g) => g.profile)]) {
    assert.strictEqual(byId.get(id).type, "profile", `${id} is a profile node`);
  }
  // The two fail-closed declarations the parser would otherwise reject, pinned
  // as properties of the emission rather than as parser behaviour.
  assert.ok(factory.protectedPaths.length && factory.testLaneProfile, "protected paths are never declared without a lane");
  for (const g of factory.gates.filter((g) => g.kind === "human")) {
    for (const cls of g.risk) assert.ok(factory.riskClasses[cls], `human gate risk class '${cls}' is declared`);
  }
});

test("an emitted profile names a harness and never what a machine executes", () => {
  // dec-spor-declarative-harness-machine-binds-execution: `spor dispatch`
  // REFUSES a profile carrying any of these, so a skill that wrote one would
  // emit a factory whose lanes can never launch.
  const FORBIDDEN = ["command", "args", "argv", "bin", "exec", "entrypoint", "env", "report", "session", "launch_mode", "identity_mode"];
  const profiles = [...nodesById().values()].filter((n) => n.type === "profile");
  assert.ok(profiles.length >= 2, "the fixture emits the review lane and the test-writer lane");
  for (const p of profiles) {
    assert.ok(p.harness, `${p.id} names a harness`);
    for (const key of FORBIDDEN) {
      assert.strictEqual(p[key], undefined, `${p.id} must not carry a machine-execution key '${key}'`);
    }
  }
});

test("the test-writer lane carries the owner's criteria and takes its readiness stamp from the CLI", () => {
  const byId = nodesById();
  const lane = [...byId.values()].find((n) => n.type === "task");
  assert.ok(lane, "a repo with no acceptance suite gets a seeded test-writer lane item");
  assert.strictEqual(lane.profile, "profile-acme-test-writer");
  assert.ok(byId.has(lane.profile), "the lane profile it names exists");
  // The acceptance criteria are the operator's own words, carried verbatim —
  // that transcription IS the non-technical operator's factory job.
  assert.match(lane.body, /Acceptance criteria/i);
  assert.match(lane.body, /"[^"]{40,}"/, "criteria are quoted from the interview, not paraphrased");
  // `readiness: agent` is a PROVENANCE-stamped override (`spor ready` writes
  // readiness/_by/_at/_via together); hand-writing the bare field would be an
  // unattributed stamp, so the emitted node deliberately carries none.
  assert.strictEqual(lane.readiness, undefined, "the readiness stamp comes from `spor ready`, not the emitted markdown");
});

test("the emitting reference's rescue block parses with the runner's own vocabulary (task-spor-factory-rescue-lane)", () => {
  // The skill teaches an operator to answer interview question 8 with this
  // exact block; if the reference drifts from parseRescue, a factory compiled
  // from it refuses to start the worker.
  const md = fs.readFileSync(path.join(SKILL_DIR, "references", "emitting.md"), "utf8");
  const section = md.slice(md.indexOf("## 3d. The rescue block"));
  const fence = /```json\n([\s\S]*?)\n```/.exec(section);
  assert.ok(fence, "the rescue section carries a json example");
  const payload = JSON.parse(fence[1]);
  const { rescue, errors } = gates.parseRescue(payload);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(rescue, { profile: "profile-claude-fable", attempts: 1, awaitMs: 3600000, instructions: "Prefer the smallest fix that makes the prior findings resolve." });
  assert.strictEqual(gates.parseRescue({ gates: [] }).rescue, null, "no block, no lane");
});
