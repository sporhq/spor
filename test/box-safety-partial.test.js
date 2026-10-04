"use strict";
// The box-safety rules in the orchestrator prompts are rendered from ONE
// partial (task-spor-consolidate-box-safety-rules). A hand-edited copy, or an
// edited partial that was not re-rendered, fails here.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const R = require("../.claude/skills/spor-orchestrator/scripts/render-box-safety.js");

test("every rendered box-safety region matches the partial", () => {
  const blocks = R.readBlocks(fs.readFileSync(R.PARTIAL, "utf8"));
  const files = R.targets();
  assert.ok(files.length >= 9, `expected the nine carrier files, found ${files.length}`);
  for (const f of files) {
    const cur = fs.readFileSync(f, "utf8");
    assert.strictEqual(R.render(cur, blocks, f), cur, `${path.basename(f)} drifted: run node .claude/skills/spor-orchestrator/scripts/render-box-safety.js`);
  }
});

test("no carrier keeps a hand-written copy of the rules outside a block", () => {
  const blocks = R.readBlocks(fs.readFileSync(R.PARTIAL, "utf8"));
  for (const f of R.targets()) {
    const stripped = fs.readFileSync(f, "utf8").replace(/<!-- box-safety:begin[\s\S]*?<!-- box-safety:end -->/g, "");
    assert.ok(!/pkill -f/.test(stripped), `${path.basename(f)} restates the pkill rule outside a block`);
    assert.ok(!/enospc-recover/.test(stripped), `${path.basename(f)} restates the ops-script rule outside a block`);
  }
  assert.ok(Object.keys(blocks).length >= 4);
});
