// Cross-surface drift guard (task-spor-status-vocab-drift-guard, following
// issue-spor-off-vocab-artifact-statuses / art-res-issue-spor-off-vocab-artifact-statuses).
//
// prompts/client/distill-local.md tells the distiller, per node type, which
// statuses it may emit ("must be valid for the type — decision: active|
// rejected; task: open|active; ..."). That line is hand-maintained separately
// from each seed schema's validate() status-membership gate
// (dec-spor-status-membership-in-validate-hook), and nothing previously caught
// the two drifting apart — the prompt could offer a status a schema now
// rejects, silently losing distilled nodes to the write-time gate.
//
// This test parses the prompt's status-offer line into (type, status) pairs
// and runs each pair through the SAME sandboxed validate() the server calls on
// write, so editing either the prompt or a seed schema out of sync reddens
// this suite.
//
// Run: node --test

require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const graph = require(path.join(__dirname, "..", "lib", "graph.js"));
const { sandboxFor } = require(path.join(__dirname, "..", "lib", "sandbox.js"));
const { Registry } = require(path.join(__dirname, "..", "lib", "kernel", "registry.js"));

const PROMPT_PATH = path.join(__dirname, "..", "prompts", "client", "distill-local.md");
const SLACK = { timeoutMs: 5000 };

// "status: <... must be valid for the type — decision: active|rejected;
// task: open|active; ...>" -> [{type: "decision", status: "active"}, ...]
function parseStatusOffer(promptText) {
  const line = promptText.match(/^status:\s*<.*>$/m);
  assert.ok(line, "distill-local.md must carry a 'status:' offer line in the node-format block");
  const body = line[0].match(/must be valid for the type\s*—\s*([^>]*)>/);
  assert.ok(body, "status line must carry a 'must be valid for the type — <type>: <a|b|...>; ...' clause");

  const pairs = [];
  for (const segment of body[1].split(";")) {
    const part = segment.trim();
    if (!part) continue;
    const [type, statuses] = part.split(":").map((s) => s.trim());
    assert.ok(type && statuses, `unparseable status-offer segment: '${segment}'`);
    for (const status of statuses.split("|").map((s) => s.trim())) {
      assert.ok(status, `unparseable status in segment: '${segment}'`);
      pairs.push({ type, status });
    }
  }
  assert.ok(pairs.length > 0, "status-offer line yielded no (type, status) pairs");
  return pairs;
}

// Runs every offered pair through its type's validate() gate and returns how
// many were actually gated. A pair whose type has no validate() (e.g. norm) is
// trivially in-vocabulary and is skipped — so a prompt left offering ONLY
// ungated types would check nothing, and the caller must refuse that
// (issue-spor-status-vocab-drift-guard-false-pass).
function checkPairsAgainstGates(pairs, seedSchemas) {
  let gated = 0;
  for (const { type, status } of pairs) {
    const schema = seedSchemas.find((s) => s.key === type);
    assert.ok(schema, `prompt offers a status for unknown seed type '${type}'`);
    const sb = sandboxFor(schema);
    if (!sb || !sb.has("validate")) continue;
    const errors = sb.call("validate", [{ id: `${type}-x`, status }], SLACK);
    assert.deepEqual(
      errors, [],
      `distill-local.md offers '${type}: ${status}' but schema-${type}'s validate() rejects it: ${errors.join("; ")}`
    );
    gated++;
  }
  const ungated = [...new Set(pairs.map((p) => p.type))].filter((t) => {
    const sb = sandboxFor(seedSchemas.find((s) => s.key === t));
    return !sb || !sb.has("validate");
  });
  assert.ok(gated > 0,
    `no offered (type, status) pair reached a validate() gate — every offered type is ungated ` +
    `(${ungated.join(", ")}), so this drift guard checked nothing`);
  return gated;
}

test("distill-local.md status offer: every (type, status) pair passes that type's validate() gate", () => {
  const promptText = fs.readFileSync(PROMPT_PATH, "utf8");
  checkPairsAgainstGates(parseStatusOffer(promptText), graph.loadSeedSchemas());
});

test("the status-offer drift guard fails loudly when only ungated types are offered", () => {
  const onlyNorm = "status: <x — must be valid for the type — norm: active>";
  assert.throws(
    () => checkPairsAgainstGates(parseStatusOffer(onlyNorm), graph.loadSeedSchemas()),
    /reached a validate\(\) gate.*norm/
  );
});

// The prompt's own prose rule (line 21: "never a completion status ... those
// are gated on a resolver already being on the graph") is enforced only by a
// human reading it. This pins that rule against the declarative registry
// surface (task-spor-registry-declarative-terminal-status-policy) instead: a
// type's status.completion is the one success value gated on a resolver, so
// an offered status equal to it would distill a node that is born already
// "done" and lose it at the completion-resolver write door.
test("distill-local.md status offer: no offered status is that type's declared status.completion", () => {
  const promptText = fs.readFileSync(PROMPT_PATH, "utf8");
  const pairs = parseStatusOffer(promptText);

  const reg = new Registry();
  for (const s of graph.loadSeedSchemas()) reg.add(s, "seed");

  for (const { type, status } of pairs) {
    const completion = reg.completionStatus(type);
    if (completion == null) continue; // this type has no single mechanical completion status
    assert.notEqual(
      status.toLowerCase(), completion,
      `distill-local.md offers '${type}: ${status}', but '${completion}' is ${type}'s declared status.completion — ` +
      `distilling it violates the prose rule directly above the status-offer line`
    );
  }
});
