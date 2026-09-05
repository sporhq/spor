// The worker contract `spor work` appends to every implementer prompt
// (lib/shell/worker-contract.js) — the standing discipline the
// /spor-orchestrator skill used to carry in prose: commit before you resolve,
// never merge to the target ref, leave the protected suite alone, resolve
// last. Pure text from a shape, so these pin the SHAPE: what a bare worker's
// contract says, what a factory adds, and what it must never mention.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");

const workerContractLib = require("../lib/shell/worker-contract.js");
const { workerContract } = workerContractLib;
const gates = require("../lib/kernel/gates.js");

function factoryOf(payload) {
  const { factory, errors } = gates.parseFactory(["```json", JSON.stringify(payload), "```"].join("\n"), { id: "factory-test" });
  assert.deepStrictEqual(errors, []);
  return factory;
}

test("a BARE worker's contract is the plain commit-then-resolve discipline, with nothing factory-specific in it", () => {
  const text = workerContract({ nodeId: "task-demo" });
  assert.match(text, /^## Worker contract/m);
  assert.match(text, /You own ONE queue item, `task-demo`/);
  assert.match(text, /Do NOT merge to `main`/);
  assert.match(text, /Landing the branch is not your job/);
  assert.match(text, /Commit everything on this branch/);
  assert.match(text, /REFUSE a tree with uncommitted changes/);
  assert.match(text, /Resolve the item on the graph LAST/);
  assert.match(text, /`resolves`\n?\s*edge to `task-demo`/);
  assert.match(text, /leave the\nitem UNRESOLVED/);
  assert.match(text, /FINDINGS: none/);
  // The one-turn notice (issue-spor-rescue-and-fix-sessions-end-turn-waiting-
  // on-background-job): a headless implementer that backgrounds its suite and
  // ends its turn "waiting" commits nothing — the contract says so plainly.
  assert.match(text, /\nSession:\nThis is a ONE-TURN headless session: it ends with your final message, and nothing wakes it later/);
  assert.match(text, /never\nbackground a test run, never spawn a watcher, and never end your turn waiting on anything/);
  assert.match(text, /an uncommitted tree is a refusal/);
  assert.match(text, /A long suite is\n   still a foreground command — run it, read its exit, THEN commit/, "step 3 repeats it where the suite is run");
  assert.strictEqual(text, `${text.split("\nSession:\n")[0]}\nSession:\n${workerContractLib.ONE_TURN_NOTICE}\n${text.split(`${workerContractLib.ONE_TURN_NOTICE}\n`)[1]}`, "the contract embeds the SHARED notice verbatim — the fix, integration and rescue prompts carry the same string");
  // The durable-debt checklist rides in the bare contract too: it is design
  // discipline, not a factory fact (task-spor-review-gate-durable-debt-flag-checklist).
  assert.match(text, /introduces or extends a durable retry\/debt flag[\s\S]*say how each is handled in the commit message/);
  assert.match(text, /\n   \(a\) the flag write itself fails[\s\S]*\n   \(b\) clear-before-owe[\s\S]*\n   \(c\) the check-then-write race[\s\S]*\n   \(d\) a stale flag against already-settled state/, "the four rows, indented under step 4");
  // A sibling check, rendered the same way (task-spor-review-gate-outcome-
  // field-forwarding-instruction).
  assert.match(text, /adds a field to an outcome\/result object recorded at more than one write site, forward it at EVERY\n   site that records that object/);
  assert.match(text, /\n   If this change adds a field to an outcome\/result object[\s\S]*\(F7: a `flake` flag reached the/, "indented under step 4, alongside the durable-debt table");
  // Nothing a bare worker has no way to honor.
  assert.doesNotMatch(text, /integration stage/);
  assert.doesNotMatch(text, /protected test paths/);
  assert.doesNotMatch(text, /acceptance command/);
  assert.doesNotMatch(text, /second model reviews/);
});

test("a FACTORY worker's contract names the integration target, the acceptance command, the protected paths and their lane, and the review", () => {
  const factory = factoryOf({
    factory: "demo",
    trusted_ref: "release",
    protected_paths: ["test/**", "spec/**"],
    test_lane_profile: "profile-test-writer",
    gates: [
      { id: "acceptance", kind: "command", command: "npm test" },
      { id: "review", kind: "agent-review", profile: "profile-reviewer" },
    ],
    integration: { mode: "local", command: "npm test" },
  });
  const text = workerContract({ nodeId: "issue-x", factory, terminal: "resolved" });
  assert.match(text, /Do NOT merge to `release`/);
  assert.match(text, /integration stage lands your branch onto `release` after the gates pass/);
  assert.match(text, /protected test paths \(`test\/\*\*`, `spec\/\*\*`\)/);
  assert.match(text, /`profile-test-writer` lane/);
  assert.match(text, /acceptance command \(`npm test`\)/);
  assert.match(text, /second model reviews `git diff release\.\.\.HEAD`/);
  assert.match(text, /terminal status \(`resolved`\)/);
  assert.match(text, /\(d\) a stale flag against already-settled state/, "the durable-debt checklist rides under a factory too");
});

test("a factory with NO integration block tells the worker landing is not its job, without naming a stage that does not exist", () => {
  const factory = factoryOf({ factory: "demo", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "npm test" }] });
  const text = workerContract({ nodeId: "task-y", factory });
  assert.match(text, /Do NOT merge to `main`/);
  assert.match(text, /Landing the branch is not your job/);
  assert.doesNotMatch(text, /integration stage/);
  assert.doesNotMatch(text, /protected test paths/);
});

test("the contract is harness-neutral — no harness-specific tool names, no back-channel to a supervisor", () => {
  const text = workerContract({ nodeId: "task-z", factory: factoryOf({ factory: "d", gates: [{ id: "g", kind: "command", command: "make check" }] }) });
  for (const banned of ["SendMessage", "Agent-tool", "subagent", "orchestrator", "/code-review"]) {
    assert.ok(!text.includes(banned), `the contract must not mention ${banned}`);
  }
  assert.match(text, /nobody is watching this session/);
});

test("both contracts carry the fixed DECLINED form the runner reads back, and say what it does", () => {
  for (const text of [workerContract({ nodeId: "task-demo" }), workerContract({ nodeId: "task-demo", factory: factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "npm test" }] }) })]) {
    assert.match(text, /If the ITEM itself is wrong/);
    assert.match(text, /FIRST line of your final message exactly `DECLINED: <one-line reason>`/);
    assert.match(text, /commit nothing, write no resolver/);
    assert.match(text, /skips the gates and goes back to triage/);
    assert.match(text, /A decline with commits behind it,\nor with a resolver written, is not a decline/);
  }
  // The form the contract prescribes is the form the contract layer parses.
  const terminal = require("../lib/shell/dispatch-terminal.js");
  assert.deepStrictEqual(terminal.parseDecline("DECLINED: premise no longer holds\n\nexplanation"), { reason: "premise no longer holds" });
});

test("both contracts carry the fixed SCOPED form too, and the form they prescribe is the one the kernel parses", () => {
  const gatesKernel = require("../lib/kernel/gates.js");
  for (const text of [workerContract({ nodeId: "task-demo" }), workerContract({ nodeId: "task-demo", factory: factoryOf({ factory: "t", trusted_ref: "main", gates: [{ id: "acceptance", kind: "command", command: "npm test" }] }) })]) {
    assert.match(text, /outcome: rescoped \| premise-stale \| duplicate/);
    assert.match(text, /FIRST line of your final message exactly\n`SCOPED: <outcome> <the node id you wrote> — <one-line reason>`/);
    // It is a claim the runner CHECKS, not a bypass — the contract has to say
    // so, or an implementer reads it as a way past the gates.
    assert.match(text, /The runner CHECKS that claim against the/);
    assert.match(text, /A claim that does not check\nout is refused exactly as an unexplained empty diff already is/);
    // ...and it is not the decline: a decline claims nothing.
    assert.match(text, /that is a\nreal outcome, not a decline/);
  }
  // The form the contract prescribes is the form the runner parses — the two
  // are changed together or a correct scoping reads as a run that did nothing.
  assert.deepStrictEqual(gatesKernel.parseNoCodeReport("SCOPED: rescoped art-scoping-x — the server half already shipped\n\nmore"), {
    ok: true,
    outcome: "rescoped",
    resolver: "art-scoping-x",
    reason: "the server half already shipped",
  });
});
