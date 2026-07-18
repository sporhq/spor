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

test("distill-local.md status offer: every (type, status) pair passes that type's validate() gate", () => {
  const promptText = fs.readFileSync(PROMPT_PATH, "utf8");
  const pairs = parseStatusOffer(promptText);
  const seedSchemas = graph.loadSeedSchemas();

  for (const { type, status } of pairs) {
    const schema = seedSchemas.find((s) => s.key === type);
    assert.ok(schema, `prompt offers a status for unknown seed type '${type}'`);
    const sb = sandboxFor(schema);
    // No attached validate() = the type has no status-membership gate at all
    // (e.g. norm), so any offered status is trivially in-vocabulary.
    if (!sb || !sb.has("validate")) continue;
    const errors = sb.call("validate", [{ id: `${type}-x`, status }], SLACK);
    assert.deepEqual(
      errors, [],
      `distill-local.md offers '${type}: ${status}' but schema-${type}'s validate() rejects it: ${errors.join("; ")}`
    );
  }
});
