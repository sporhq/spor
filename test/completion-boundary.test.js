// CONTROLLER COMPLETION (task-spor-factory-controller-completion-boundary,
// FACTORY-IMPLEMENTATION-STAGE.md §4.3-§4.5, §6.1, §6.5): the resolving edge
// and the terminal status written by the RUNNER at the declared boundary, the
// EXECUTION HOLD that keeps a premature resolution inert on both halves of
// liveness, the worker-contract split, the `completion_debt` and its four
// failure modes, and the compare-and-swap with its 409 branches.
//
// Layers, each with its own oracle (§6.6's test list, rows named per test):
//   1. the kernel hold (lib/kernel/resolution.js, queue.js, graph.js) over an
//      in-memory graph — the review's own queue probe, made a test;
//   2. the seed schema hooks (schema-task/-issue) through the real sandbox;
//   3. the worker contract — byte-identical goldens for the legacy shapes,
//      the two declared variants;
//   4. the pure predicates (lib/kernel/completion.js);
//   5. the completion runner (lib/shell/completion.js) against fake doors —
//      the forced order, owe-first, every 409 branch, the retype;
//   6. the local-mode doors through bin/spor.js against a scratch graph —
//      the blob-sha CAS, setStatusLocal's refusal, H1, `spor release
//      --execution`, `spor get`'s hold note.
// No live graph, no network, no model call.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const graphLib = require("../lib/graph.js");
const resolution = require("../lib/kernel/resolution.js");
const queue = require("../lib/kernel/queue.js");
const { walkProgram } = require("../lib/kernel/program.js");
const { rankQueue } = require("../lib/queue.js");
const { sandboxFor } = require("../lib/sandbox.js");
const gates = require("../lib/kernel/gates.js");
const workerContractLib = require("../lib/shell/worker-contract.js");
const completion = require("../lib/kernel/completion.js");
const shell = require("../lib/shell/completion.js");
const workLoop = require("../lib/shell/work-loop.js");
const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
const { loadConfig } = require("../lib/config.js");
const spor = require("../bin/spor.js");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const NOW = Date.parse("2026-09-06T12:00:00Z");

// ---------- fixtures ----------

function tmpGraph(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-completion-"));
  const nodesDir = path.join(dir, "nodes");
  fs.mkdirSync(nodesDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(nodesDir, name), content);
  return { dir, nodesDir, load: () => graphLib.loadGraph(nodesDir) };
}

const node = (id, type, { status, project = "spor", edges = [], extra = "" } = {}) => [
  `${id}.md`,
  `---
id: ${id}
type: ${type}
project: ${project}
title: Title of ${id}
summary: Standalone summary for ${id} used by the completion-boundary tests.
date: 2026-09-01
${status ? `status: ${status}\n` : ""}${extra}${edges.length ? `edges:\n${edges.map((e) => `  - {type: ${e[0]}, to: ${e[1]}}`).join("\n")}\n` : ""}---
Body of ${id}.
`,
];

function factoryOf(payload) {
  const { factory, errors } = gates.parseFactory(["```json", JSON.stringify(payload), "```"].join("\n"), { id: "factory-test" });
  assert.deepEqual(errors, []);
  return factory;
}

// ---------- 1. the kernel hold (§4.5, §6.6 test 1) ----------

test("hold, edge half: a resolves edge onto a HELD item retires nothing — its dependent stays blocked — and the same graph with the hold removed releases it", () => {
  const held = tmpGraph(Object.fromEntries([
    node("task-up", "task", { status: "open", extra: "execution: exec-1\nexecution_at: 2026-09-06T00:00:00Z\n", edges: [["blocks", "task-down"]] }),
    node("task-down", "task", { status: "open" }),
    node("dec-early", "decision", { edges: [["resolves", "task-up"]] }),
  ]));
  const g = held.load();
  assert.equal(resolution.executionHeld(g.nodes["task-up"]), true);
  assert.equal(resolution.resolutionMap(g)["task-up"], undefined, "no inbound resolving edge retires a held item");
  assert.deepEqual(resolution.inboundResolvers(g, "task-up").map((r) => r.by), ["dec-early"], "...but the inert resolver is listed for the controller");
  assert.equal(queue.isLive(g.nodes["task-up"], g.supersededBy, g), true);
  const ranked = rankQueue(g, { now: NOW });
  assert.equal(ranked.items.find((i) => i.id === "task-down"), undefined, "task-down is hidden from the actionable queue while its blocker is held");
  assert.equal(ranked.blocked, 1, "...and counted as blocked");
  assert.deepEqual(queue.liveBlockers(g, "task-down", queue.blockersIndex(g), resolution.resolutionMap(g)), ["task-up"]);
  const prog = walkProgram(g, "task-down");
  assert.equal(prog.tree.find((n) => n.id === "task-up").bucket, "open", "the program view reads the held blocker as live, never done");

  // The completion write's effect: the hold removed, the edge counts.
  const released = tmpGraph(Object.fromEntries([
    node("task-up", "task", { status: "open", edges: [["blocks", "task-down"]] }),
    node("task-down", "task", { status: "open" }),
    node("dec-early", "decision", { edges: [["resolves", "task-up"]] }),
  ]));
  const g2 = released.load();
  assert.equal(resolution.resolutionMap(g2)["task-up"].by, "dec-early");
  const ranked2 = rankQueue(g2, { now: NOW });
  assert.ok(ranked2.items.find((i) => i.id === "task-down"), "with the hold gone, task-down is released into the actionable queue");
  assert.ok(!ranked2.blocked);
  assert.equal(walkProgram(g2, "task-down").tree.find((n) => n.id === "task-up").bucket, "done");
});

test("hold, status half: a `done` written under the hold is still live — blockingCount counts it, the dependent stays blocked, and the read surface reports HELD not done", () => {
  const t = tmpGraph(Object.fromEntries([
    node("task-up", "task", { status: "done", extra: "execution: exec-1\n", edges: [["blocks", "task-down"]] }),
    node("task-down", "task", { status: "open" }),
  ]));
  const g = t.load();
  assert.equal(queue.isLive(g.nodes["task-up"], g.supersededBy, g), true, "a held item is live whatever its status says");
  assert.equal(queue.liveBlockers(g, "task-down", queue.blockersIndex(g), resolution.resolutionMap(g)).length, 1, "task-up still blocks task-down");
  assert.equal(rankQueue(g, { now: NOW }).blocked, 1);
  const rendered = graphLib.compile(g, { rootId: "task-down", digest: false });
  assert.match(rendered.text || rendered, /task-up — Title of task-up \(task, 2026-09-01, done — HELD by execution exec-1, not retired\)/);
  assert.equal(walkProgram(g, "task-down").tree.find((n) => n.id === "task-up").bucket, "open", "held: never done in the program view");
  // Without the hold, the same status retires it.
  const plain = tmpGraph(Object.fromEntries([node("task-up", "task", { status: "done", edges: [["blocks", "task-down"]] }), node("task-down", "task", { status: "open" })])).load();
  assert.equal(queue.isLive(plain.nodes["task-up"], plain.supersededBy, plain), false);
  assert.equal(queue.liveBlockers(plain, "task-down", queue.blockersIndex(plain), resolution.resolutionMap(plain)).length, 0);
});

test("hold, the person's door: an item ABANDONED under the hold is dead on the status half (a hold keeps a completion inert, not a decision to drop work), and the reconciler withdraws the hold", async () => {
  const t = tmpGraph(Object.fromEntries([
    node("task-up", "task", { status: "abandoned", extra: "execution: exec-1\n", edges: [["blocks", "task-down"]] }),
    node("task-down", "task", { status: "open" }),
  ]));
  const g = t.load();
  assert.equal(queue.isLive(g.nodes["task-up"], g.supersededBy, g), false);
  assert.ok(rankQueue(g, { now: NOW }).items.find((i) => i.id === "task-down"), "task-down is released by the abandonment");
  assert.equal(resolution.isGiveUpStatus("rejected", "decision", { registry: graphLib.seedRegistry() }), true);
  assert.equal(resolution.isGiveUpStatus("done", "task", { registry: graphLib.seedRegistry() }), false);
  const fg = fakeGraph({ status: "abandoned" });
  fg.rec.gates_state = "failed";
  const res = await shell.reconcileCompletion({ record: fg.rec, deps: fg.deps });
  assert.equal(res.debt, "withdraw");
  assert.equal(res.settled, "withdrawn");
  assert.equal(fg.execOf(), "", "the hold is cleared");
  assert.equal(fg.statusOf(), "abandoned");
});

test("executionHeld: only a non-empty string is a hold", () => {
  for (const v of [undefined, null, "", "  ", true, 1, {}]) assert.equal(resolution.executionHeld({ execution: v }), false, JSON.stringify(v));
  assert.equal(resolution.executionHeld({ execution: "exec-abc" }), true);
  assert.equal(resolution.executionHeld(null), false);
});

// ---------- 2. the seed schema hooks (write-side hygiene, §4.5) ----------

for (const [id, terminal] of [["schema-task", "done"], ["schema-issue", "resolved"]]) {
  test(`${id}: transitions() refuses '${terminal}' on a proposed node still carrying execution:, and passes the completion CAS body that removes it; get() rides execution_hold instead of resolution`, () => {
    const schema = graphLib.loadSeedSchemas().find((s) => s.id === id);
    const sb = sandboxFor(schema);
    const view = { resolvers: [{ id: "dec-x", type: "decision", status: "" }], non_resolving_statuses: [] };
    const refused = sb.call("transitions", [{}, { status: terminal, execution: "exec-1" }, view], { timeoutMs: 5000 });
    assert.equal(refused.allow, false);
    assert.match(refused.reason, /under execution 'exec-1'/);
    assert.match(refused.reason, /spor release <id> --execution exec-1/);
    assert.deepEqual(sb.call("transitions", [{ status: "open", execution: "exec-1" }, { status: terminal }, view], { timeoutMs: 5000 }), { allow: true }, "the CAS body (key removed) passes");
    assert.equal(sb.call("transitions", [{}, { status: "abandoned", execution: "exec-1" }, view], { timeoutMs: 5000 }).allow, id === "schema-task", "abandoned (the person's other door) is not gated by the hold");
    const ctx = { neighbors: [{ id: "dec-a", edge: "resolves", dir: "in", type: "decision", status: "" }], non_resolving_statuses: [] };
    const heldRead = sb.call("get", [{ id: "task-x", type: "task", execution: "exec-1", execution_at: "2026-09-06T00:00:00Z" }, ctx], { timeoutMs: 5000 });
    assert.equal(heldRead.resolution, undefined, "no resolution ride-along under the hold");
    assert.equal(heldRead.execution_hold.id, "exec-1");
    assert.deepEqual(heldRead.execution_hold.inert_resolvers, [{ by: "dec-a", edge: "resolves", type: "decision" }]);
    assert.match(heldRead.execution_hold.note, /under execution exec-1 since 2026-09-06T00:00:00Z/);
    assert.equal(sb.call("get", [{ id: "task-x", type: "task" }, ctx], { timeoutMs: 5000 }).resolution.by, "dec-a", "no hold: the ride-along is unchanged");
  });
}

test("setStatusLocal refuses a completion status on a held node (naming the execution and the person's door), allows the give-up status, and allows the completion once the hold is cleared", () => {
  const t = tmpGraph(Object.fromEntries([node("task-x", "task", { status: "open", extra: "execution: exec-1\n" }), node("dec-r", "decision", { edges: [["resolves", "task-x"]] })]));
  const cfg = loadConfig({ cwd: t.dir, env: { SPOR_HOME: t.dir, XDG_CONFIG_HOME: t.dir } });
  const r = spor.setStatusLocal(cfg, "task-x", "done");
  assert.equal(r.ok, false);
  assert.match(r.reason, /under execution 'exec-1'/);
  assert.match(r.reason, /spor release task-x --execution exec-1/);
  assert.equal(spor.setStatusLocal(cfg, "task-x", "abandoned").ok, true, "abandoned is the person's door and passes");
  const abandoned = fs.readFileSync(path.join(t.nodesDir, "task-x.md"), "utf8");
  assert.doesNotMatch(abandoned, /^execution:/m, "...and ends the execution in the same write");
  assert.match(abandoned, /^execution_released_by: set-status:abandoned@/m);
  fs.writeFileSync(path.join(t.nodesDir, "task-x.md"), node("task-x", "task", { status: "open" })[1]);
  assert.equal(spor.setStatusLocal(cfg, "task-x", "done").ok, true);
});

// ---------- 3. the worker contract (§6.1, §6.6 test 8) ----------

test("worker contract: a factory declaring NEITHER key — and a bare worker — produce the exact bytes they did before the stage existed (goldens)", () => {
  const dir = path.join(__dirname, "fixtures", "worker-contract");
  const legacy = factoryOf({
    factory: "golden", trusted_ref: "release", protected_paths: ["test/**", "spec/**"], test_lane_profile: "profile-test-writer",
    gates: [{ id: "acceptance", kind: "command", command: "npm test" }, { id: "review", kind: "agent-review", profile: "profile-reviewer" }],
    integration: { mode: "local", command: "npm test" },
  });
  assert.equal(workerContractLib.workerContract({ nodeId: "task-golden" }), fs.readFileSync(path.join(dir, "bare.txt"), "utf8"));
  assert.equal(workerContractLib.workerContract({ nodeId: "issue-golden", factory: legacy, terminal: "resolved" }), fs.readFileSync(path.join(dir, "legacy.txt"), "utf8"));
  const noInt = factoryOf({ factory: "golden", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "make check" }] });
  assert.equal(workerContractLib.workerContract({ nodeId: "task-golden", factory: noInt }), fs.readFileSync(path.join(dir, "legacy-no-integration.txt"), "utf8"));
});

test("worker contract: `completion.by: controller` alone changes ONLY the completion step — submission, no resolves edge, no status flip, the CANDIDATE: form", () => {
  const base = { factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "npm test" }] };
  const legacy = workerContractLib.workerContract({ nodeId: "task-x", terminal: "done", factory: factoryOf(base) });
  const ctrl = workerContractLib.workerContract({ nodeId: "task-x", terminal: "done", factory: factoryOf({ ...base, completion: { by: "controller" } }) });
  assert.notEqual(ctrl, legacy);
  assert.match(ctrl, /5\. Submit the candidate LAST/);
  assert.match(ctrl, /carrying a `relates-to` edge\n\s+to `task-x` — NOT a `resolves` edge — and do NOT flip the item's status \(never set `done`\)/);
  assert.match(ctrl, /inert under the item's execution hold/);
  assert.match(ctrl, /FIRST line of your final message exactly `CANDIDATE: <the resolver\n\s+node id> — <one-line reason>`/);
  assert.match(ctrl, /committed, clean, submitted on the graph/);
  assert.doesNotMatch(ctrl, /5\. Resolve the item on the graph LAST/);
  // Step 3 is untouched by the completion key alone (E10): every command gate
  // is still named, nothing is withheld.
  assert.match(ctrl, /acceptance command \(`npm test`\), which the gate re-runs/);
  assert.doesNotMatch(ctrl, /do NOT run/);
  // The prescribed form is the form the kernel parses.
  assert.deepEqual(completion.parseCandidateReport("CANDIDATE: dec-my-change — the smallest fix\n\nmore"), { ok: true, resolver: "dec-my-change", reason: "the smallest fix" });
});

test("worker contract: an implementation: block narrows step 3 to author_checks and NAMES the suites it withholds; instructions are appended, never replacing the contract", () => {
  const text = workerContractLib.workerContract({
    nodeId: "task-x",
    factory: factoryOf({
      factory: "t", trusted_ref: "main",
      gates: [{ id: "typecheck", kind: "command", command: "npm run typecheck" }, { id: "acceptance", kind: "command", command: "npm test" }, { id: "browser", kind: "command", command: "npm run e2e" }],
      implementation: { author_checks: ["typecheck"], instructions: "Prefer the smallest change that makes the suite honest." },
    }),
  });
  assert.match(text, /acceptance command \(`npm run typecheck`\)/);
  assert.match(text, /The factory runs `npm test`, `npm run e2e` from the trusted ref's copy after you finish — do NOT run them here/);
  assert.match(text, /Factory lane instructions[^\n]*\nPrefer the smallest change that makes the suite honest\./);
  assert.match(text, /5\. Submit the candidate LAST/, "an implementation block defaults completion to the controller");
  // The stage with agent completion kept: routing narrowed, resolve kept.
  const agentKept = workerContractLib.workerContract({
    nodeId: "task-x",
    factory: factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "npm test" }], implementation: {}, completion: { by: "agent" } }),
  });
  assert.match(agentKept, /5\. Resolve the item on the graph LAST/);
  assert.match(agentKept, /The factory runs `npm test` from the trusted ref's copy after you finish — do NOT run it here/);
  assert.equal(workerContractLib.CANDIDATE_FORM, "CANDIDATE:");
});

// ---------- 4. the pure predicates (§6.5) ----------

function claim(over = {}) {
  return {
    execution_id: "exec-0123456789abcdef",
    claimed_at: "2026-09-06T00:00:00Z",
    completion: { by: "controller", after: "gates" },
    publish: { kind: "bundle" },
    factory: { node_id: "factory-t", revision: "abc" },
    resolving_snapshot: [],
    status_snapshot: "open",
    ...over,
  };
}
function record(over = {}) {
  return { run_id: "run-1", node_id: "task-x", impl_claim: claim(), impl_state: "candidate", impl_candidate: { candidate_id: "cand-1111222233334444", commit: "b".repeat(40), tree: "a".repeat(40) }, ...over };
}

test("parseCandidateReport reads the first non-blank line only, in the fixed form, and never throws on junk", () => {
  assert.deepEqual(completion.parseCandidateReport("\n  CANDIDATE: art-x-1 - done\nrest"), { ok: true, resolver: "art-x-1", reason: "done" });
  assert.deepEqual(completion.parseCandidateReport("CANDIDATE: dec-only"), { ok: true, resolver: "dec-only", reason: "" });
  assert.deepEqual(completion.parseCandidateReport("I wrote CANDIDATE: dec-x"), { ok: false });
  assert.deepEqual(completion.parseCandidateReport("DECLINED: nope"), { ok: false });
  assert.deepEqual(completion.parseCandidateReport(""), { ok: false });
  assert.deepEqual(completion.parseCandidateReport(null), { ok: false });
});

test("executionIdFor: exec- plus 16 hex of the server's NUL-joined key over tenant, item, factory and pipeline attempt (task-spor-client-execution-store-adapter)", () => {
  const parts = { tenant: "acme", nodeId: "task-x", factoryId: "factory-t", pipelineAttempt: 1 };
  const id = completion.executionIdFor(parts, sha256);
  assert.equal(id, `exec-${sha256("acme\u0000task-x\u0000factory-t\u00001").slice(0, 16)}`);
  assert.notEqual(id, completion.executionIdFor({ ...parts, pipelineAttempt: 2 }, sha256), "a fresh pipeline attempt is a fresh execution");
  assert.equal(completion.executionIdFor({ ...parts, tenant: "" }, sha256), completion.executionIdFor({ ...parts, tenant: "local" }, sha256));
  assert.equal(completion.executionIdFor({ ...parts, pipelineAttempt: undefined }, sha256), id, "the first attempt is the default");
  // The literal the server's own reducer mints for the same inputs (pinned
  // from lib-engine/kernel/execution.js at spor-server bdad326): a local
  // execution and a hosted one describe the same thing.
  assert.equal(completion.executionIdFor({ tenant: "local", nodeId: "task-x", factoryId: "factory-t", pipelineAttempt: 1 }, sha256), "exec-4da6d4763543a301");
  assert.throws(() => completion.executionIdFor(parts, null), /sha256/);
});

test("boundaryReached reads the PINNED boundary against the split states — gates passed + integration running under after:integration derives NOTHING (F12), the same inputs under after:gates do", () => {
  const afterInt = record({ impl_claim: claim({ completion: { by: "controller", after: "integration" } }), gates_state: "passed", integration_state: "running", gate_state: "passed" });
  assert.equal(completion.boundaryReached(afterInt), false);
  assert.equal(completion.boundaryReached({ ...afterInt, integration_state: "landed" }), true);
  assert.equal(completion.boundaryReached({ ...afterInt, integration_state: "parked" }), false, "parked waits for the landed fact");
  assert.equal(completion.boundaryReached({ ...afterInt, integration_state: "parked" }, { landedFactPresent: true }), true);
  const afterGates = record({ gates_state: "passed", integration_state: "running" });
  assert.equal(completion.boundaryReached(afterGates), true);
  assert.equal(completion.boundaryReached(record({ gates_state: "failed" })), false);
  assert.equal(completion.boundaryReached({ run_id: "legacy", gate_state: "passed" }), false, "a legacy record has no boundary");
  assert.equal(completion.isControllerRecord({ impl_claim: { completion: { by: "agent" } } }), false);
});

test("deriveCompletionDebt reconciles against settled state: write at the boundary, nothing when already settled elsewhere, withdraw on abandoned, retract on a premature edge under our hold, nothing on a superseded record", () => {
  const rec = record({ gates_state: "passed" });
  const held = { status: "open", execution: "exec-0123456789abcdef", terminal: false, inbound: [] };
  assert.equal(completion.deriveCompletionDebt({ record: rec, item: held }), "write");
  assert.equal(completion.deriveCompletionDebt({ record: record({ gates_state: "passed", impl_state: "running" }), item: held }), "write", "an UNSETTLED stage (no verified reference yet — publishing is the sibling's) still completes: the gates judged the tree");
  assert.equal(completion.deriveCompletionDebt({ record: record({ gates_state: "passed", impl_state: "dispatched" }), item: held }), "write", "a completion-only factory never pins and stays dispatched — it completes too");
  for (const refused of ["declined", "exhausted", "escalated", "unroutable", "mismatch"]) {
    assert.equal(completion.deriveCompletionDebt({ record: record({ gates_state: "passed", impl_state: refused }), item: held }), null, `a stage settled '${refused}' never completes`);
  }
  assert.equal(completion.deriveCompletionDebt({ record: record({ gates_state: "failed" }), item: { ...held, status: "abandoned", terminal: true } }), "withdraw", "abandoned under OUR hold with nothing of ours written: the hold is still withdrawn (the person's door must clear it)");
  assert.equal(completion.deriveCompletionDebt({ record: rec, item: { status: "done", execution: "", terminal: true, inbound: [{ by: "dec-other", edge: "resolves" }] } }), null, "resolved by a different candidate: consumed");
  assert.equal(completion.deriveCompletionDebt({ record: rec, item: { status: "done", execution: "", terminal: true, inbound: [] }, own: { id: "art-completion-x", resolvesEdge: true } }), null, "already written");
  assert.equal(completion.deriveCompletionDebt({ record: rec, item: { status: "abandoned", execution: "", terminal: true, inbound: [] }, own: { id: "art-completion-x", resolvesEdge: true } }), "withdraw");
  assert.equal(completion.deriveCompletionDebt({ record: rec, item: { status: "abandoned", execution: "", terminal: true, inbound: [] }, own: { id: "art-completion-x", resolvesEdge: false } }), null, "abandoned, hold gone, nothing of ours: nothing to withdraw");
  const notReached = record({ gates_state: "failed" });
  assert.equal(completion.deriveCompletionDebt({ record: notReached, item: { ...held, inbound: [{ by: "dec-early", edge: "resolves" }] } }), "retract");
  assert.equal(completion.deriveCompletionDebt({ record: notReached, item: { ...held, execution: "exec-other", inbound: [{ by: "dec-early", edge: "resolves" }] } }), null, "not our hold: nothing to retract");
  assert.equal(completion.deriveCompletionDebt({ record: { ...rec, gate_state: "superseded" }, item: held }), null);
  assert.equal(completion.deriveCompletionDebt({ record: rec, item: null }), null, "an unreadable item derives nothing");
});

test("prematureResolvers: anything not in the claim snapshot, whoever wrote it, except our own completion resolver", () => {
  const inbound = [{ by: "dec-early", edge: "resolves" }, { by: "dec-seen", edge: "resolves" }, { by: "art-completion-x-1", edge: "resolves" }, { by: "dec-rel", edge: "relates-to" }];
  assert.deepEqual(completion.prematureResolvers(inbound, [{ by: "dec-seen", edge: "resolves" }], { ownResolver: "art-completion-x-1" }), [{ by: "dec-early", edge: "resolves" }]);
  assert.deepEqual(completion.prematureResolvers(inbound, ["dec-seen", "dec-early"]).map((r) => r.by), ["art-completion-x-1"]);
});

test("the completion resolver: content-addressed to the candidate, carries the resolves edge in the same write, links the facts and the implementer's account, and parses", () => {
  const id = completion.completionResolverId("task-my-item", "cand-1111222233334444");
  assert.equal(id, "art-completion-my-item-111122223333");
  assert.equal(completion.completionResolverId("task-my-item", "cand-9999"), "art-completion-my-item-9999");
  const built = completion.buildCompletionResolver({
    id, nodeId: "task-my-item", candidate: { candidate_id: "cand-1111222233334444", commit: "b".repeat(40), tree: "a".repeat(40), branch: "task-my-item" },
    executionId: "exec-0123456789abcdef", boundary: "gates", project: "spor", date: "2026-09-06", factory: "factory-t",
    facts: ["art-gate-acceptance-x", "art-gate-review-x"], implementerResolver: "dec-my-why", premature: ["dec-early"],
  });
  const parsed = graphLib.parseFrontmatter(built.markdown, `${id}.md`);
  assert.equal(parsed.type, "artifact");
  assert.deepEqual(parsed.edges.map((e) => `${e.type}:${e.to}`), ["resolves:task-my-item", "relates-to:art-gate-acceptance-x", "relates-to:art-gate-review-x", "relates-to:dec-my-why"]);
  assert.equal(parsed.candidate_id, "cand-1111222233334444");
  assert.equal(parsed.completion_boundary, "gates");
  assert.equal(String(parsed.premature_resolution), "true");
  assert.match(built.markdown, /dependents were released by this\ncompletion and by nothing before it/);
  assert.match(built.markdown, /premature resolution was recorded and retyped as evidence[^\n]*`dec-early`/);
});

// ---------- 5. the completion runner against fake doors (§4.3, §6.5, §6.6 tests 9, 10, 12) ----------

// A fake graph: one item file (raw + revision counter), resolver nodes with
// edges, and every door recording what it was asked. `bump()` moves the item's
// revision between a read and the CAS, the F2/F10 race.
function fakeGraph({ status = "open", execution = "exec-0123456789abcdef", inbound = [], type = "task" } = {}) {
  const state = {
    raw: `---\nid: task-x\ntype: ${type}\nproject: spor\ntitle: X\nsummary: X.\ndate: 2026-09-01\n${status ? `status: ${status}\n` : ""}${execution ? `execution: ${execution}\nexecution_at: 2026-09-06T00:00:00Z\n` : ""}edges:\n  - {type: blocks, to: task-down}\n---\nBody.\n`,
    revision: 1,
    nodes: new Map(),
    edges: [],
    inbound: inbound.slice(),
    stamps: [],
    implStamps: [],
    casCalls: 0,
    onCas: null,
    failCas: null,
    failEdge: null,
  };
  for (const r of inbound) state.nodes.set(r.by, { edges: [{ type: r.edge, to: "task-x" }] });
  const statusOf = () => (/^status:\s*(.*)$/m.exec(state.raw) || [])[1] || "";
  const execOf = () => (/^execution:\s*(.*)$/m.exec(state.raw) || [])[1] || "";
  const terminal = (s) => ["done", "resolved", "abandoned"].includes(String(s).toLowerCase());
  const rec = { run_id: "run-1", node_id: "task-x", impl_claim: claim(), impl_state: "candidate", impl_candidate: { candidate_id: "cand-1111222233334444", commit: "b".repeat(40), tree: "a".repeat(40) }, gates_state: "passed" };
  const deps = {
    readItem: async () => ({ ok: true, status: statusOf(), type, terminal: terminal(statusOf()), giveUp: statusOf().toLowerCase() === "abandoned", execution: execOf(), executionAt: "2026-09-06T00:00:00Z", revision: String(state.revision), raw: state.raw, inbound: state.inbound.map((r) => ({ ...r })), resolvedBy: null }),
    casWrite: async ({ revision, raw }) => {
      state.casCalls += 1;
      if (state.onCas) state.onCas();
      if (state.failCas) return { ok: false, reason: state.failCas };
      if (String(revision) !== String(state.revision)) return { ok: false, conflict: true, reason: "stale revision" };
      state.raw = raw;
      state.revision += 1;
      return { ok: true, revision: String(state.revision) };
    },
    writeNode: async (id, markdown) => {
      const parsed = graphLib.parseFrontmatter(markdown, `${id}.md`);
      if (state.nodes.has(id)) return { ok: true, existing: true };
      state.nodes.set(id, { edges: parsed.edges || [], markdown });
      for (const e of parsed.edges || []) if (e.to === "task-x" && (e.type === "resolves" || e.type === "answers")) state.inbound.push({ by: id, edge: e.type });
      return { ok: true };
    },
    readNode: async (id) => (state.nodes.has(id) ? { ok: true, edges: state.nodes.get(id).edges, status: "", type: "artifact" } : null),
    addEdge: async (from, t, to) => {
      if (state.failEdge) return { ok: false, reason: state.failEdge };
      state.edges.push(`+${from}:${t}:${to}`);
      const n = state.nodes.get(from) || { edges: [] };
      n.edges = [...n.edges, { type: t, to }];
      state.nodes.set(from, n);
      if (to === "task-x" && (t === "resolves" || t === "answers")) state.inbound.push({ by: from, edge: t });
      return { ok: true };
    },
    removeEdge: async (from, t, to) => {
      if (state.failEdge) return { ok: false, reason: state.failEdge };
      state.edges.push(`-${from}:${t}:${to}`);
      const n = state.nodes.get(from);
      if (n) n.edges = n.edges.filter((e) => !(e.type === t && e.to === to));
      state.inbound = state.inbound.filter((r) => !(r.by === from && r.edge === t));
      return { ok: true };
    },
    completionStatus: () => (type === "issue" ? "resolved" : "done"),
    stamp: (patch) => {
      state.stamps.push({ ...patch });
      Object.assign(rec, patch);
      return rec;
    },
    stampImpl: (patch) => {
      state.implStamps.push({ ...patch });
      Object.assign(rec, patch);
      return rec;
    },
    now: () => NOW,
  };
  return { state, deps, rec, statusOf, execOf, setStatus: (s) => { state.raw = state.raw.replace(/^status:.*$/m, `status: ${s}`); state.revision += 1; }, bump: () => { state.revision += 1; } };
}

test("stampHold (H1): stamps execution:/execution_at: by CAS and returns the claim pins; a foreign hold, a live resolving edge, and a lost CAS each refuse with no hold written; our own hold re-stamps idempotently", async () => {
  const fresh = fakeGraph({ execution: "" });
  const held = await shell.stampHold({ nodeId: "task-x", executionId: "exec-0123456789abcdef", deps: fresh.deps });
  assert.equal(held.ok, true);
  assert.equal(held.restamped, false);
  assert.equal(fresh.execOf(), "exec-0123456789abcdef");
  assert.match(fresh.state.raw, /execution_at: 2026-09-06T12:00:00\.000Z/);
  assert.deepEqual(held.pins.resolving_snapshot, []);
  assert.equal(held.pins.status_snapshot, "open");
  assert.equal(held.pins.revision, "2");
  const again = await shell.stampHold({ nodeId: "task-x", executionId: "exec-0123456789abcdef", deps: fresh.deps });
  assert.equal(again.ok, true);
  assert.equal(again.restamped, true, "a same-execution resume re-stamps without a write");
  assert.equal(fresh.state.casCalls, 1);

  const foreign = fakeGraph({ execution: "exec-other" });
  const f = await shell.stampHold({ nodeId: "task-x", executionId: "exec-0123456789abcdef", deps: foreign.deps });
  assert.equal(f.ok, false);
  assert.equal(f.kind, "foreign-hold");
  assert.match(f.reason, /held by execution exec-other/);
  assert.equal(foreign.state.casCalls, 0, "no hold, no write");

  const resolved = fakeGraph({ execution: "", inbound: [{ by: "dec-done", edge: "resolves" }] });
  const r = await shell.stampHold({ nodeId: "task-x", executionId: "exec-0123456789abcdef", deps: resolved.deps });
  assert.equal(r.kind, "not-gateable");
  assert.match(r.reason, /dec-done/);

  const racing = fakeGraph({ execution: "" });
  racing.state.onCas = () => racing.bump();
  const lost = await shell.stampHold({ nodeId: "task-x", executionId: "exec-0123456789abcdef", deps: racing.deps });
  assert.equal(lost.ok, false);
  assert.equal(lost.kind, "conflict");
  assert.equal(racing.execOf(), "", "H2: the hold did not land");
});

test("clearHold clears only a hold naming this execution (or any, under force, recording who released it); an unheld item is a no-op", async () => {
  const g = fakeGraph();
  assert.equal((await shell.clearHold({ nodeId: "task-x", executionId: "exec-other", deps: g.deps })).ok, false);
  assert.equal(g.execOf(), "exec-0123456789abcdef");
  const c = await shell.clearHold({ nodeId: "task-x", executionId: "exec-other", deps: g.deps, force: true, releasedBy: "person@now" });
  assert.equal(c.cleared, true);
  assert.equal(g.execOf(), "");
  assert.doesNotMatch(g.state.raw, /execution_at/);
  assert.match(g.state.raw, /execution_released_by: person@now/);
  assert.equal((await shell.clearHold({ nodeId: "task-x", executionId: "exec-0123456789abcdef", deps: g.deps })).cleared, false);
});

test("writeCompletion, the forced order: owe `write` FIRST, the resolver with its resolves edge, then ONE CAS writing the terminal status and removing the hold; the debt clears only after; the candidate's resolver is filled", async () => {
  const g = fakeGraph();
  const res = await shell.writeCompletion({ record: g.rec, deps: g.deps, facts: ["art-gate-acceptance-x"], boundary: "gates" });
  assert.equal(res.ok, true);
  assert.equal(res.settled, "written");
  assert.equal(res.resolver, "art-completion-x-111122223333");
  assert.deepEqual(g.state.stamps[0], { completion_debt: "write" }, "owe-first");
  const last = g.state.stamps[g.state.stamps.length - 1];
  assert.equal(last.completion_debt, null);
  assert.equal(last.completion_boundary, "gates");
  assert.equal(last.completion_resolver, "art-completion-x-111122223333");
  assert.ok(last.completion_written_at);
  const resolver = g.state.nodes.get("art-completion-x-111122223333");
  assert.ok(resolver, "the resolver exists");
  assert.ok(resolver.edges.some((e) => e.type === "resolves" && e.to === "task-x"), "with its resolves edge, in the same write");
  assert.match(resolver.markdown, /relates-to, to: art-gate-acceptance-x/);
  assert.equal(g.statusOf(), "done");
  assert.equal(g.execOf(), "", "the hold is gone in the same CAS as the status");
  assert.doesNotMatch(g.state.raw, /execution_at/);
  assert.match(g.state.raw, /- \{type: blocks, to: task-down\}/, "every other line of the item is kept");
  assert.equal(g.state.casCalls, 1);
  assert.deepEqual(g.state.implStamps[0].impl_candidate.resolver, { node: "art-completion-x-111122223333", written: true, resolves_edge: true });
  // Re-driven after a crash between the resolver and the status (§6.5 (b)):
  // idempotent — the resolver is found, only step 2 runs.
  const crashed = fakeGraph();
  crashed.rec.completion_debt = "write";
  await crashed.deps.writeNode("art-completion-x-111122223333", g.state.nodes.get("art-completion-x-111122223333").markdown);
  const redo = await shell.writeCompletion({ record: crashed.rec, deps: crashed.deps, boundary: "gates" });
  assert.equal(redo.settled, "written");
  assert.equal(crashed.state.stamps.some((s) => s.completion_debt === "write"), false, "already owed: not re-owed");
  assert.equal(crashed.statusOf(), "done");
});

test("writeCompletion retypes a PREMATURE edge before writing its own (P1 at submission), records it on the record, and the completion names it as evidence", async () => {
  const g = fakeGraph({ inbound: [{ by: "dec-early", edge: "resolves" }] });
  const res = await shell.writeCompletion({ record: g.rec, deps: g.deps, boundary: "gates" });
  assert.equal(res.settled, "written");
  assert.deepEqual(g.state.edges.slice(0, 2), ["-dec-early:resolves:task-x", "+dec-early:relates-to:task-x"]);
  assert.deepEqual(g.rec.completion_premature, ["dec-early"]);
  assert.match(g.state.nodes.get("art-completion-x-111122223333").markdown, /premature_resolution: true/);
  assert.ok(g.state.inbound.some((r) => r.by === "art-completion-x-111122223333" && r.edge === "resolves"), "ours is the only resolving edge left");
});

test("the 409 branches: abandoned under us -> withdraw (our edge retyped back, the hold cleared, no status write); done with the hold gone -> consumed; done with our hold present -> a hold-clear-only CAS; a priority bump -> retry lands; a fourth consecutive loss leaves `write` owed", async () => {
  // abandoned between the read and the write
  const ab = fakeGraph();
  let once = false;
  ab.state.onCas = () => { if (!once) { once = true; ab.setStatus("abandoned"); } };
  const w = await shell.writeCompletion({ record: ab.rec, deps: ab.deps, boundary: "gates" });
  assert.equal(w.settled, "withdrawn");
  assert.equal(ab.statusOf(), "abandoned", "a gate never reverses a person's decision to drop work");
  assert.equal(ab.execOf(), "", "the hold is cleared alone");
  assert.ok(ab.state.edges.includes("-art-completion-x-111122223333:resolves:task-x") && ab.state.edges.includes("+art-completion-x-111122223333:relates-to:task-x"));
  assert.equal(ab.rec.completion_debt, null);
  assert.ok(ab.rec.completion_withdrawn_at);

  // done, hold released by a person who resolved it themselves
  const dn = fakeGraph();
  once = false;
  dn.state.onCas = () => { if (!once) { once = true; dn.state.raw = dn.state.raw.replace(/^execution:.*\n/m, "").replace(/^execution_at:.*\n/m, ""); dn.setStatus("done"); dn.state.inbound.push({ by: "dec-theirs", edge: "resolves" }); } };
  const c = await shell.writeCompletion({ record: dn.rec, deps: dn.deps, boundary: "gates" });
  assert.equal(c.settled, "consumed");
  assert.equal(dn.state.casCalls, 1, "nothing more written");
  assert.ok(dn.rec.completion_consumed_at);

  // done by set_status past the gate, with our hold still present
  const dh = fakeGraph();
  once = false;
  dh.state.onCas = () => { if (!once) { once = true; dh.setStatus("done"); } };
  const h = await shell.writeCompletion({ record: dh.rec, deps: dh.deps, boundary: "gates" });
  assert.equal(h.settled, "written");
  assert.equal(dh.statusOf(), "done");
  assert.equal(dh.execOf(), "", "the retry writes the hold-clear on the fresh revision; the person's status stands");
  assert.equal(dh.state.casCalls, 2);

  // a priority bump
  const pb = fakeGraph();
  once = false;
  pb.state.onCas = () => { if (!once) { once = true; pb.bump(); } };
  const p = await shell.writeCompletion({ record: pb.rec, deps: pb.deps, boundary: "gates" });
  assert.equal(p.settled, "written");
  assert.equal(pb.state.casCalls, 2);

  // a hold taken over by a different execution (a --regate under a fresh id)
  const other = fakeGraph();
  once = false;
  other.state.onCas = () => { if (!once) { once = true; other.state.raw = other.state.raw.replace(/^execution:.*$/m, "execution: exec-fresh"); other.state.revision += 1; } };
  const o = await shell.writeCompletion({ record: other.rec, deps: other.deps, boundary: "gates" });
  assert.equal(o.settled, "withdrawn");
  assert.equal(other.execOf(), "exec-fresh", "the other execution's hold is never touched");
  assert.equal(other.statusOf(), "open");

  // four consecutive losses
  const lose = fakeGraph();
  lose.state.onCas = () => lose.bump();
  const l = await shell.writeCompletion({ record: lose.rec, deps: lose.deps, boundary: "gates" });
  assert.equal(l.ok, false);
  assert.equal(l.retry, true);
  assert.equal(lose.rec.completion_debt, "write", "left owed for the next pass");
  assert.equal(lose.state.casCalls, 4);
});

test("the F2 race: a resolving edge from a DIFFERENT resolver added between the read and the write leaves the revision unchanged — the CAS lands, the foreign edge was inert until then and is retyped by P1's rule on the next pass", async () => {
  const g = fakeGraph();
  let once = false;
  g.state.onCas = () => { if (!once) { once = true; g.state.inbound.push({ by: "dec-foreign", edge: "resolves" }); g.state.nodes.set("dec-foreign", { edges: [{ type: "resolves", to: "task-x" }] }); } };
  const res = await shell.writeCompletion({ record: g.rec, deps: g.deps, boundary: "gates" });
  assert.equal(res.settled, "written");
  assert.equal(g.state.casCalls, 1);
  // The next pass: the hold is gone, so the foreign edge is no longer premature
  // (the item is completed; a second resolving edge is harmless provenance).
  const again = await shell.retractPremature({ record: g.rec, deps: g.deps });
  assert.deepEqual(again, { ok: true, retyped: [], note: "not held by this execution" });
});

test("retractPremature: owes `retract` first and clears it only after both halves landed; a status flipped under the hold is rolled back to the snapshot; a failed retype keeps the debt; an abandoned item is left alone", async () => {
  const g = fakeGraph({ inbound: [{ by: "dec-early", edge: "resolves" }] });
  g.rec.gates_state = "failed";
  g.setStatus("done");
  const r = await shell.retractPremature({ record: g.rec, deps: g.deps });
  assert.equal(r.ok, true);
  assert.deepEqual(r.retyped, ["dec-early"]);
  assert.equal(g.state.stamps[0].completion_debt, "retract");
  assert.equal(g.rec.completion_debt, null);
  assert.equal(g.statusOf(), "open", "rolled back to the claim's snapshot");
  assert.equal(g.execOf(), "exec-0123456789abcdef", "the hold is kept");
  // fails
  const bad = fakeGraph({ inbound: [{ by: "dec-early", edge: "resolves" }] });
  bad.state.failEdge = "server down";
  const b = await shell.retractPremature({ record: bad.rec, deps: bad.deps });
  assert.equal(b.ok, false);
  assert.equal(bad.rec.completion_debt, "retract", "the debt stands");
  // abandoned
  const ab = fakeGraph({ status: "abandoned", inbound: [{ by: "dec-early", edge: "resolves" }] });
  const a = await shell.retractPremature({ record: ab.rec, deps: ab.deps });
  assert.deepEqual(a.retyped, []);
  assert.equal(ab.state.edges.length, 0);
});

test("reconcileCompletion re-derives the debt from settled state every pass: a boundary reached but unwritten completes; after:integration with the integration running writes nothing; a settled record is skipped; a stale `retract` against an edge already gone is consumed", async () => {
  const g = fakeGraph();
  const res = await shell.reconcileCompletion({ record: g.rec, deps: g.deps });
  assert.equal(res.debt, "write");
  assert.equal(res.settled, "written");
  const running = fakeGraph();
  running.rec.impl_claim = claim({ completion: { by: "controller", after: "integration" } });
  running.rec.integration_state = "running";
  assert.equal(await shell.reconcileCompletion({ record: running.rec, deps: running.deps }), null, "F12: nothing derived");
  assert.equal(running.state.casCalls, 0);
  running.rec.integration_state = "parked";
  assert.equal(await shell.reconcileCompletion({ record: running.rec, deps: running.deps }), null, "parked without the landed fact");
  const parkedLanded = await shell.reconcileCompletion({ record: running.rec, deps: running.deps, landedFactPresent: true });
  assert.equal(parkedLanded.settled, "written");
  assert.equal(await shell.reconcileCompletion({ record: g.rec, deps: g.deps }), null, "settled: skipped without a read");
  const stale = fakeGraph();
  stale.rec.gates_state = "failed";
  stale.rec.completion_debt = "retract";
  assert.equal(await shell.reconcileCompletion({ record: stale.rec, deps: stale.deps }), null);
  assert.equal(stale.rec.completion_debt, null, "consumed");
  // A stale `write` beside a graph that now shows a premature edge: the field
  // is overwritten with the derived debt in one stamp, then worked.
  const staleWrite = fakeGraph({ inbound: [{ by: "dec-early", edge: "resolves" }] });
  staleWrite.rec.gates_state = "failed";
  staleWrite.rec.completion_debt = "write";
  const sw = await shell.reconcileCompletion({ record: staleWrite.rec, deps: staleWrite.deps });
  assert.equal(sw.debt, "retract");
  assert.deepEqual(sw.retyped, ["dec-early"]);
  assert.equal(staleWrite.rec.completion_debt, null);
  assert.equal(await shell.reconcileCompletion({ record: { run_id: "legacy", gate_state: "passed" }, deps: stale.deps }), null, "a legacy record is never touched");
});

test("a refusal writes NO resolving edge and clears NO hold: the dependent stays blocked (§4.4)", async () => {
  const g = fakeGraph();
  g.rec.gates_state = "failed";
  assert.equal(await shell.reconcileCompletion({ record: g.rec, deps: g.deps }), null);
  assert.equal(g.execOf(), "exec-0123456789abcdef");
  assert.equal(g.state.inbound.length, 0);
  assert.equal(g.statusOf(), "open");
});

test("shouldGate: a controller record is gated on every terminal state but declined — an ENFORCED reported is the candidate submission; a legacy record reads exactly as before", () => {
  const ctrl = { impl_claim: claim() };
  assert.equal(workLoop.shouldGate({ terminal_state: "reported", terminal_enforced: true }, ctrl), true);
  assert.equal(workLoop.shouldGate({ terminal_state: "failed", terminal_enforced: true }, ctrl), true);
  assert.equal(workLoop.shouldGate({ terminal_state: "declined", terminal_enforced: true }, ctrl), false);
  assert.equal(workLoop.shouldGate({ terminal_state: "reported", terminal_enforced: true }, { impl_claim: { completion: { by: "agent" } } }), false);
  assert.equal(workLoop.shouldGate({ terminal_state: "reported", terminal_enforced: true }, { run_id: "legacy" }), false);
  assert.equal(workLoop.shouldGate({ terminal_state: "reported", terminal_enforced: true }), false);
});

test("stampCompletionState stamps only its namespace, and carryGateFields carries it across an in-process whole-record write", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-completion-runs-"));
  const p = dispatchRuns.runPaths(home, "run-1");
  fs.mkdirSync(path.dirname(p.record), { recursive: true });
  fs.writeFileSync(p.record, JSON.stringify({ run_id: "run-1", state: "done" }));
  assert.equal(dispatchRuns.stampCompletionState(home, "run-1", { state: "running" }), null, "outside the namespace: refused");
  const stamped = dispatchRuns.stampCompletionState(home, "run-1", { completion_debt: "write", gates_state: "passed", integration_state: "running", state: "running" });
  assert.equal(stamped.completion_debt, "write");
  assert.equal(stamped.state, "done");
  assert.equal(stamped.gates_state, "passed");
  // A supervisor's whole-record write that read BEFORE the stamp keeps it.
  const carried = dispatchRuns.stampRun(home, "run-1", { finished_at: "x" });
  assert.equal(carried.completion_debt, "write");
  assert.equal(carried.gates_state, "passed");
  assert.equal(JSON.parse(fs.readFileSync(p.record, "utf8")).integration_state, "running");
  assert.equal(dispatchRuns.isCompletionField("completion_resolver"), true);
  assert.equal(dispatchRuns.isCompletionField("gate_state"), false);
});

// ---------- 6. the local-mode doors through bin/spor.js (§4.3 "Local mode", §6.6 test 10's last line) ----------

function localCfg(dir) {
  return loadConfig({ cwd: dir, env: { SPOR_HOME: dir, XDG_CONFIG_HOME: dir } });
}

test("local mode: completionReadItem lists the inert resolvers under the hold; completionCasWrite is a blob-sha compare-and-swap that catches a hand edit and writes temp-plus-rename", async () => {
  const t = tmpGraph(Object.fromEntries([
    node("task-x", "task", { status: "open", extra: "execution: exec-1\n", edges: [["blocks", "task-down"]] }),
    node("task-down", "task", { status: "open" }),
    node("dec-early", "decision", { edges: [["resolves", "task-x"]] }),
  ]));
  const cfg = localCfg(t.dir);
  const item = await spor.completionReadItem(cfg, "task-x");
  assert.equal(item.ok, true);
  assert.equal(item.execution, "exec-1");
  assert.deepEqual(item.inbound, [{ by: "dec-early", edge: "resolves" }]);
  assert.equal(item.resolvedBy, null, "under the hold, nothing resolves it");
  assert.equal(item.revision, spor.gitBlobSha(fs.readFileSync(path.join(t.nodesDir, "task-x.md"))));
  const raw2 = shell.setFrontmatterKey(item.raw, "status", "done");
  // A hand edit between the read and the write is caught.
  fs.appendFileSync(path.join(t.nodesDir, "task-x.md"), "\nA hand edit.\n");
  const stale = await spor.completionCasWrite(cfg, { nodeId: "task-x", revision: item.revision, raw: raw2 }, { home: t.dir });
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  const fresh = await spor.completionReadItem(cfg, "task-x");
  const wrote = await spor.completionCasWrite(cfg, { nodeId: "task-x", revision: fresh.revision, raw: shell.setFrontmatterKey(fresh.raw, "status", "done") }, { home: t.dir });
  assert.equal(wrote.ok, true);
  assert.match(fs.readFileSync(path.join(t.nodesDir, "task-x.md"), "utf8"), /^status: done$/m);
  assert.deepEqual(fs.readdirSync(t.nodesDir).filter((f) => f.endsWith(".tmp")), [], "no temp file left behind");
  const bad = await spor.completionCasWrite(cfg, { nodeId: "task-x", revision: wrote.revision, raw: "not a node" }, { home: t.dir });
  assert.equal(bad.ok, false, "a rewritten node that does not validate is refused");
  assert.deepEqual(fs.readdirSync(path.join(t.dir, "nodes")).sort(), ["dec-early.md", "task-down.md", "task-x.md"]);
});

test("local mode, end to end through the real doors: H1 holds the item and pins the claim; the completion write retires it with our resolver, clears the hold, and the dependent is released", async () => {
  const t = tmpGraph(Object.fromEntries([
    node("task-x", "task", { status: "open", edges: [["blocks", "task-down"]] }),
    node("task-down", "task", { status: "open" }),
  ]));
  const cfg = localCfg(t.dir);
  const factory = factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "true" }], completion: { by: "controller" } });
  factory.id = "factory-t";
  const lines = [];
  const held = await spor.claimExecutionHold(cfg, { id: "task-x" }, factory, { home: t.dir, log: (l) => lines.push(l) });
  assert.equal(held.ok, true);
  assert.match(held.executionId, /^exec-[0-9a-f]{16}$/);
  assert.equal(held.recordFields.impl_claim.completion.after, "gates");
  assert.equal(held.recordFields.impl_state, "dispatched");
  assert.deepEqual(held.recordFields.impl_claim.resolving_snapshot, []);
  assert.match(fs.readFileSync(path.join(t.nodesDir, "task-x.md"), "utf8"), new RegExp(`^execution: ${held.executionId}$`, "m"));
  // The claim OPENED the execution in the store (task-spor-client-execution-
  // store-adapter): the id is the store's, the fence is the first lease's.
  assert.equal(held.store, "local");
  assert.equal(held.fence, 1);
  assert.equal(held.recordFields.impl_claim.store, "local");
  assert.equal(held.recordFields.impl_claim.pipeline_attempt, 1);
  assert.equal(held.recordFields.impl_claim.tenant, "local");
  // A second claim by a DIFFERENT worker of the same item is refused (H2):
  // the first execution's lease is live. (The same worker re-opening is a
  // RESUME — the store hands its own execution back — not a second one.)
  const other = loadConfig({ cwd: t.dir, env: { SPOR_HOME: t.dir, XDG_CONFIG_HOME: t.dir, SPOR_DISPATCH_AGENT: "agent-other" } });
  const second = await spor.claimExecutionHold(other, { id: "task-x" }, factory, { home: t.dir });
  assert.equal(second.ok, false);
  assert.equal(second.kind, "foreign-hold");
  assert.match(second.reason, /is held by/);
  const same = await spor.claimExecutionHold(cfg, { id: "task-x" }, factory, { home: t.dir });
  assert.equal(same.ok, true, "the same worker re-claiming is a resume of the live execution");
  assert.equal(same.executionId, held.executionId);
  // The queue: task-down is blocked, and stays so with a premature edge.
  fs.writeFileSync(path.join(t.nodesDir, "dec-early.md"), node("dec-early", "decision", { edges: [["resolves", "task-x"]] })[1]);
  let g = graphLib.loadGraph(t.nodesDir);
  assert.equal(rankQueue(g, { now: NOW }).items.find((i) => i.id === "task-down"), undefined, "task-down is hidden (blocked) under the hold, premature edge or not");
  assert.equal(rankQueue(g, { now: NOW }).blocked, 1);
  // The completion write, on a record carrying the pins.
  const home = t.dir;
  const p = dispatchRuns.runPaths(home, "run-1");
  fs.mkdirSync(path.dirname(p.record), { recursive: true });
  const rec = { run_id: "run-1", node_id: "task-x", state: "done", item_repo: "spor", ...held.recordFields, impl_state: "candidate", impl_candidate: { candidate_id: "cand-1111222233334444", commit: "b".repeat(40), tree: "a".repeat(40) }, gates_state: "passed" };
  fs.writeFileSync(p.record, JSON.stringify(rec));
  const deps = spor.makeCompletionDeps(cfg, { home, runId: "run-1" });
  const res = await shell.writeCompletion({ record: rec, deps, boundary: "gates", facts: [], log: (l) => lines.push(l) });
  assert.equal(res.settled, "written", lines.join("\n"));
  g = graphLib.loadGraph(t.nodesDir);
  assert.equal(g.nodes["task-x"].status, "done");
  assert.equal(g.nodes["task-x"].execution, undefined);
  assert.equal(resolution.resolutionMap(g)["task-x"].by, "art-completion-x-111122223333");
  const dec = g.nodes["dec-early"].edges;
  assert.deepEqual(dec.map((e) => e.type), ["relates-to"], "the premature edge was retyped as evidence");
  assert.ok(rankQueue(g, { now: NOW }).items.find((i) => i.id === "task-down"), "task-down is released by the completion and by nothing before it");
  const written = JSON.parse(fs.readFileSync(p.record, "utf8"));
  assert.equal(written.completion_debt, null);
  assert.equal(written.completion_resolver, "art-completion-x-111122223333");
  assert.deepEqual(written.completion_premature, ["dec-early"]);
  assert.equal(written.impl_candidate.resolver.resolves_edge, true);
  // The reconciler finds nothing left to do.
  await spor.reconcileCompletions(cfg, { home, log: (l) => lines.push(l) });
  assert.equal(JSON.parse(fs.readFileSync(p.record, "utf8")).completion_written_at, written.completion_written_at);
});

// ---------- dispatchThroughLocked / dispatchWorkItem: a recorded launch wins
// over the exit code (issue-spor-dispatch-through-locked-post-launch-failure-
// clears-execution-hold) ----------

test("dispatchWorkItem under `completion.by: controller`: a fake dispatcher that records a launch via ctx.onLaunch and then exits 1 is reported ok:true and the execution hold stays in place — a post-launch failure must never clear a hold while an agent may be running", async () => {
  const t = tmpGraph(Object.fromEntries([node("task-x", "task", { status: "open" })]));
  const cfg = localCfg(t.dir);
  const factory = factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "true" }], completion: { by: "controller" } });
  factory.id = "factory-t";
  const lines = [];
  const fakeCmdDispatch = async (fcfg, { values }, ctx) => {
    ctx.onLaunch({ run_id: "run-fake-1", harness: "fake", launch_mode: "supervised-jsonl", node_id: values.node, record_path: path.join(t.dir, "run-fake-1.json") });
    // The launch is recorded; a failure AFTER it (a post-launch session
    // capture/bind, say) must not read as a refusal.
    return 1;
  };
  const result = await spor.dispatchWorkItem(cfg, { id: "task-x" }, {}, { factory, home: t.dir, log: (l) => lines.push(l), cmdDispatch: fakeCmdDispatch });
  assert.equal(result.ok, true, lines.join("\n"));
  assert.equal(result.run.run_id, "run-fake-1");
  // The hold is still stamped on the node — nothing cleared it.
  const raw = fs.readFileSync(path.join(t.nodesDir, "task-x.md"), "utf8");
  assert.match(raw, /^execution: exec-[0-9a-f]{16}$/m);
  assert.deepEqual(
    lines.filter((l) => /execution hold .* could not be cleared/.test(l)),
    [],
    "clearHold must never even be attempted for a launched run"
  );
  // A second hold claim by another worker is refused (H2): the first is still live.
  const other = loadConfig({ cwd: t.dir, env: { SPOR_HOME: t.dir, XDG_CONFIG_HOME: t.dir, SPOR_DISPATCH_AGENT: "agent-other" } });
  const second = await spor.claimExecutionHold(other, { id: "task-x" }, factory, { home: t.dir });
  assert.equal(second.ok, false);
  assert.equal(second.kind, "foreign-hold");
});

test("dispatchWorkItem under `completion.by: controller`: a fake dispatcher that records NO launch and exits 1 is reported ok:false and clears the execution hold — the refusal path still works", async () => {
  const t = tmpGraph(Object.fromEntries([node("task-x", "task", { status: "open" })]));
  const cfg = localCfg(t.dir);
  const factory = factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "true" }], completion: { by: "controller" } });
  factory.id = "factory-t";
  const lines = [];
  const fakeCmdDispatch = async () => 1; // never calls ctx.onLaunch — nothing was launched
  const result = await spor.dispatchWorkItem(cfg, { id: "task-x" }, {}, { factory, home: t.dir, log: (l) => lines.push(l), cmdDispatch: fakeCmdDispatch });
  assert.equal(result.ok, false);
  const raw = fs.readFileSync(path.join(t.nodesDir, "task-x.md"), "utf8");
  assert.doesNotMatch(raw, /^execution:/m, "a launch-free refusal still clears the hold it just claimed");
});

// issue-spor-remove-edge-line-flow-form-only-retract-never-converges: the
// same real-doors path as the test above, but the premature `resolves` edge
// is authored in YAML BLOCK form ("- type: resolves" / indented "to: task-x"
// — a shape a human or an LLM distiller might hand-write, and one
// parseFrontmatter has always accepted). Before the fix, removeEdgeLine only
// matched the flow-form "- {type: X, to: Y}" line, so the retract inside
// writeCompletion failed and the pipeline would re-log the same retype on
// every pass without ever converging.
test("local mode, end to end through the real doors: a premature `resolves` edge authored in BLOCK form is retracted just as cleanly as flow form", async () => {
  const t = tmpGraph(Object.fromEntries([
    node("task-x", "task", { status: "open", edges: [["blocks", "task-down"]] }),
    node("task-down", "task", { status: "open" }),
  ]));
  const cfg = localCfg(t.dir);
  const factory = factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "true" }], completion: { by: "controller" } });
  factory.id = "factory-t";
  const lines = [];
  const held = await spor.claimExecutionHold(cfg, { id: "task-x" }, factory, { home: t.dir, log: (l) => lines.push(l) });
  assert.equal(held.ok, true);
  // The premature edge, hand-authored in block form rather than flow form.
  fs.writeFileSync(path.join(t.nodesDir, "dec-early.md"), `---
id: dec-early
type: decision
project: spor
title: Title of dec-early
summary: Standalone summary for dec-early used by the completion-boundary tests.
date: 2026-09-01
edges:
  - type: resolves
    to: task-x
---
Body of dec-early.
`);
  let g = graphLib.loadGraph(t.nodesDir);
  assert.deepEqual(g.nodes["dec-early"].edges, [{ type: "resolves", to: "task-x" }], "fixture sanity: block-form edge parses");
  const home = t.dir;
  const p = dispatchRuns.runPaths(home, "run-1");
  fs.mkdirSync(path.dirname(p.record), { recursive: true });
  const rec = { run_id: "run-1", node_id: "task-x", state: "done", item_repo: "spor", ...held.recordFields, impl_state: "candidate", impl_candidate: { candidate_id: "cand-1111222233334444", commit: "b".repeat(40), tree: "a".repeat(40) }, gates_state: "passed" };
  fs.writeFileSync(p.record, JSON.stringify(rec));
  const deps = spor.makeCompletionDeps(cfg, { home, runId: "run-1" });
  const res = await shell.writeCompletion({ record: rec, deps, boundary: "gates", facts: [], log: (l) => lines.push(l) });
  assert.equal(res.settled, "written", lines.join("\n"));
  g = graphLib.loadGraph(t.nodesDir);
  assert.equal(g.nodes["task-x"].status, "done");
  assert.equal(resolution.resolutionMap(g)["task-x"].by, "art-completion-x-111122223333");
  const dec = g.nodes["dec-early"].edges;
  assert.deepEqual(dec, [{ type: "relates-to", to: "task-x" }], "the block-form premature edge was retyped as evidence, not left dangling");
  const written = JSON.parse(fs.readFileSync(p.record, "utf8"));
  assert.equal(written.completion_debt, null, "converges: nothing left owed");
  assert.deepEqual(written.completion_premature, ["dec-early"]);
  // The reconciler finds nothing left to do — a second pass must not re-log
  // the same retract as a failure.
  await spor.reconcileCompletions(cfg, { home, log: (l) => lines.push(l) });
  assert.equal(JSON.parse(fs.readFileSync(p.record, "utf8")).completion_written_at, written.completion_written_at);
});

test("local mode: a refused pipeline's record is NOT consumed while the item still carries its hold (a later abandon must still be seen), and is consumed once the person's door ended the execution", async () => {
  const t = tmpGraph(Object.fromEntries([node("task-x", "task", { status: "open", extra: "execution: exec-refused\n" })]));
  const cfg = localCfg(t.dir);
  const home = t.dir;
  const p = dispatchRuns.runPaths(home, "run-refused");
  fs.mkdirSync(path.dirname(p.record), { recursive: true });
  fs.writeFileSync(p.record, JSON.stringify({ run_id: "run-refused", node_id: "task-x", state: "done", impl_claim: claim({ execution_id: "exec-refused" }), impl_state: "running", gate_state: "failed", gates_state: "failed" }));
  const lines = [];
  await spor.reconcileCompletions(cfg, { home, log: (l) => lines.push(l) });
  let rec = JSON.parse(fs.readFileSync(p.record, "utf8"));
  assert.equal(rec.completion_consumed_at, undefined, "still held by this execution: kept under watch");
  assert.match(fs.readFileSync(path.join(t.nodesDir, "task-x.md"), "utf8"), /^execution: exec-refused$/m, "a refusal clears no hold");
  assert.equal(spor.setStatusLocal(cfg, "task-x", "abandoned").ok, true);
  await spor.reconcileCompletions(cfg, { home, log: (l) => lines.push(l) });
  rec = JSON.parse(fs.readFileSync(p.record, "utf8"));
  assert.ok(rec.completion_consumed_at, `consumed once the hold is gone (${lines.join(" | ")})`);
  assert.match(rec.completion_note, /no longer carries its hold/);
});

test("the CLI: `spor get` notes a HELD node (stale when its worker is gone), and `spor release <id> --execution <exec>` clears the hold in local mode", () => {
  const t = tmpGraph(Object.fromEntries([node("task-x", "task", { status: "open", extra: "execution: exec-dead\nexecution_at: 2026-09-06T00:00:00Z\n" })]));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("SPOR_") && !k.startsWith("SUBSTRATE_") && k !== "XDG_CONFIG_HOME") env[k] = v;
  env.SPOR_HOME = t.dir;
  env.XDG_CONFIG_HOME = t.dir;
  const p = dispatchRuns.runPaths(t.dir, "run-dead");
  fs.mkdirSync(path.dirname(p.record), { recursive: true });
  fs.writeFileSync(p.record, JSON.stringify({ run_id: "run-dead", node_id: "task-x", state: "done", impl_claim: claim({ execution_id: "exec-dead" }), gate_state: "running", gate_worker: "worker-gone" }));
  const got = spawnSync(process.execPath, [CLI, "get", "task-x"], { encoding: "utf8", env });
  assert.equal(got.status, 0, got.stderr);
  assert.match(got.stdout, /^execution: exec-dead$/m);
  assert.match(got.stderr, /task-x is HELD by execution exec-dead \(STALE — run run-dead on this box, its worker is gone/);
  assert.match(got.stderr, /spor release task-x --execution exec-dead/);
  const wrong = spawnSync(process.execPath, [CLI, "release", "task-x", "--execution", "exec-other"], { encoding: "utf8", env });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /held by execution exec-dead, not exec-other/);
  const rel = spawnSync(process.execPath, [CLI, "release", "task-x", "--execution", "exec-dead"], { encoding: "utf8", env });
  assert.equal(rel.status, 0, rel.stderr);
  assert.match(rel.stdout, /released execution exec-dead on task-x/);
  const raw = fs.readFileSync(path.join(t.nodesDir, "task-x.md"), "utf8");
  assert.doesNotMatch(raw, /^execution:/m);
  assert.doesNotMatch(raw, /^execution_at:/m);
  assert.match(raw, /^execution_released_by: /m);
  const again = spawnSync(process.execPath, [CLI, "get", "task-x"], { encoding: "utf8", env });
  assert.doesNotMatch(again.stderr, /HELD/);
});

// ---------- the implementation stage's launch stamps (I1, §5.1, §6.5) ----------
// task-spor-factory-implementation-stage-runner: the record a stage launch is
// CREATED with reserves attempt 1 on the ledger (pending, charging nothing)
// and carries the factory's declared per-run ceilings, or none when it
// inherits the worker's.

test("claimExecutionHold reserves implementation attempt 1 on the record's creation write and stamps only the DECLARED budget ceilings", async () => {
  const t = tmpGraph(Object.fromEntries([node("task-x", "task", { status: "open" })]));
  const cfg = localCfg(t.dir);
  const declared = factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "true" }], implementation: { budget: { run_max_ms: 3600000, run_idle_ms: 0, attempts: 2 } } });
  declared.id = "factory-t";
  const held = await spor.claimExecutionHold(cfg, { id: "task-x" }, declared, { home: t.dir });
  assert.equal(held.ok, true);
  const rf = held.recordFields;
  assert.deepEqual(rf.impl_attempts.map((a) => [a.index, a.outcome, a.pool, a.run_id]), [[1, "pending", null, null]], "reserved, not charged (I1)");
  assert.equal(rf.impl_attempts[0].started_at, rf.impl_claim.claimed_at);
  assert.deepEqual(rf.impl_budget, { run_max_ms: 3600000, run_idle_ms: 0 }, "a declared 0 idle IS the disable and rides through");
  assert.equal(spor.implBudgetStamp(declared.implementation).impl_budget.run_max_ms, 3600000);

  const t2 = tmpGraph(Object.fromEntries([node("task-y", "task", { status: "open" })]));
  const inherits = factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "true" }], implementation: {} });
  inherits.id = "factory-t";
  const held2 = await spor.claimExecutionHold(localCfg(t2.dir), { id: "task-y" }, inherits, { home: t2.dir });
  assert.equal(held2.ok, true);
  assert.equal(held2.recordFields.impl_budget, undefined, "a factory that inherits both ceilings stamps none — the poll falls through to the worker's");
  assert.deepEqual(spor.implBudgetStamp(null), {});

  const t3 = tmpGraph(Object.fromEntries([node("task-z", "task", { status: "open" })]));
  const agentOnly = factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "true" }], completion: { by: "controller" } });
  agentOnly.id = "factory-t";
  const held3 = await spor.claimExecutionHold(localCfg(t3.dir), { id: "task-z" }, agentOnly, { home: t3.dir });
  assert.equal(held3.ok, true);
  assert.equal(held3.recordFields.impl_attempts.length, 1, "the boundary alone still reserves the attempt — the ledger is the record's shape under controller completion");
  assert.equal(held3.recordFields.impl_budget, undefined);
});

// A resolver's own review stage is not an owner's decision to give up.
test("give-up is type-aware, requires inert status, and never borrows another type's declaration", async () => {
  const t = tmpGraph(Object.fromEntries([
    node("art-review", "artifact", { status: "in-review", extra: "execution: exec-1\n" }),
    node("art-approved", "artifact", { status: "approved", extra: "execution: exec-1\n" }),
    node("task-gone", "task", { status: "abandoned", extra: "execution: exec-1\n" }),
  ]));
  const g = t.load();
  for (const id of ["art-review", "art-approved"]) {
    const n = g.nodes[id];
    assert.equal(resolution.isGiveUpStatus(n.status, n.type, g), false);
    assert.equal(queue.isLive(n, g.supersededBy, g), true);
    assert.equal((await spor.completionReadItem(localCfg(t.dir), id)).giveUp, false);
  }
  assert.equal(resolution.isGiveUpStatus("abandoned", "task", g), true);
  assert.equal(resolution.isGiveUpStatus("abandoned", "artifact", g), false);
  assert.equal(resolution.isGiveUpStatus("rejected", "task", g), false);
  assert.equal(resolution.isGiveUpStatus("abandoned", null, g), false);
  assert.throws(() => resolution.isGiveUpStatus("abandoned", g), /type.*string/);
  assert.deepEqual([...g.registry.nonResolvingStatuses("artifact")].sort(), ["approved", "in-review"]);
  assert.ok(g.registry.nonResolvingStatuses().has("abandoned"), "resolver-side global union remains compatible");
});

test("organization give-up partitions govern local queue, completion and status writes", async () => {
  const issueSchema = `---\nid: schema-issue\ntype: schema\nkind: node-schema\nschema_version: 2026.09.06.9\ntitle: Custom issue lifecycle\nsummary: An organization can decline an issue.\ndate: 2026-09-06\n---\n\n\`\`\`json\n${JSON.stringify({ node_type: "issue", prefix: ["issue-"], queueable: true, status: { non_resolving: ["declined", "reviewing"], terminal: ["declined"], vocabulary: ["open", "resolved", "declined", "reviewing"] } })}\n\`\`\`\n`;
  const t = tmpGraph(Object.fromEntries([
    ["schema-issue.md", issueSchema],
    node("issue-x", "issue", { status: "reviewing", extra: "execution: exec-1\n" }),
    node("task-x", "task", { status: "declined", extra: "execution: exec-2\n" }),
  ]));
  let g = t.load();
  assert.equal(resolution.isGiveUpStatus("declined", "issue", g), true);
  assert.equal(resolution.isGiveUpStatus("reviewing", "issue", g), false);
  assert.equal(resolution.isGiveUpStatus("declined", "task", g), false);
  assert.equal((await spor.completionReadItem(localCfg(t.dir), "issue-x")).giveUp, false);
  const changed = spor.setStatusLocal(localCfg(t.dir), "issue-x", "declined");
  assert.equal(changed.ok, true, changed.reason);
  g = t.load();
  assert.equal(g.nodes["issue-x"].execution, undefined);
  assert.equal(queue.isLive(g.nodes["issue-x"], g.supersededBy, g), false);
  assert.equal((await spor.completionReadItem(localCfg(t.dir), "issue-x")).giveUp, true);
});

test("remote completion reads authoritative organization status partitions and refuses unavailable policy", async (t) => {
  const http = require("node:http");
  const snapshot = graphLib.seedRegistry().snapshot();
  const custom = snapshot.node_types.find((n) => n.type === "issue");
  custom.non_resolving = ["declined", "reviewing"]; custom.terminal = ["declined"]; custom.inert = ["declined"];
  let status = "declined", type = "issue", schemaMode = "okay", explicitInert;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.method + " " + req.url);
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/schema") {
      if (schemaMode === "unavailable") { res.statusCode = 503; res.end(JSON.stringify({ error: "unavailable" })); return; }
      if (schemaMode === "old") { res.statusCode = 404; res.end("{}"); return; }
      if (schemaMode === "malformed") { res.end("{}"); return; }
      res.end(JSON.stringify(snapshot)); return;
    }
    res.end(JSON.stringify({ raw: node("issue-x", type, { status, extra: "execution: exec-1\n" })[1], revision: "rev-a", ...(explicitInert === undefined ? {} : { inert: explicitInert }) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const cfg = { mode: () => "remote", server: () => `http://127.0.0.1:${server.address().port}`, token: () => "test-token", tenant: () => null };
  let item = await spor.completionReadItem(cfg, "issue-x");
  assert.equal(item.ok, true); assert.equal(item.giveUp, true); assert.equal(item.terminal, true);
  status = "reviewing";
  item = await spor.completionReadItem(cfg, "issue-x");
  assert.equal(item.giveUp, false); assert.equal(item.terminal, false);
  status = "declined"; type = "task";
  assert.equal((await spor.completionReadItem(cfg, "issue-x")).giveUp, false, "other types do not borrow the issue's give-up status");
  status = "abandoned"; explicitInert = false;
  item = await spor.completionReadItem(cfg, "issue-x");
  assert.equal(item.terminal, false); assert.equal(item.giveUp, false, "authoritative false is not overwritten by a local heuristic");
  for (schemaMode of ["unavailable", "old", "malformed"]) {
    item = await spor.completionReadItem(cfg, "issue-x");
    assert.equal(item.ok, false); assert.match(item.reason, /live status policy could not be read/);
  }
  assert.ok(requests.every((r) => r.startsWith("GET ")), "policy uncertainty never mutates the hold");
});
