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

// A marker pair the renderer skipped (or one with nothing between) is silent
// drift the byte-compare cannot see: render() of an empty pair that was never
// matched reproduces itself (issue-spor-box-safety-partial-empty-list-item-block).
const KEY_TERMS = {
  "ops-script": ["enospc-recover", "mkdtemp", "--apply"],
  "ops-script-infra": ["enospc-recover", "mkdtemp", "--apply"],
  "kill-own": ["pkill -f", "pgid"],
  "foreground-suite": ["setsid", "poll", "FOREGROUND"],
};

test("every rendered box-safety region is non-empty and carries its key terms", () => {
  const blocks = R.readBlocks(fs.readFileSync(R.PARTIAL, "utf8"));
  for (const name of Object.keys(blocks)) assert.ok(KEY_TERMS[name], `no key terms registered for block ${name}`);
  let regions = 0;
  for (const f of R.targets()) {
    const re = /^[ \t]*<!-- box-safety:begin (\S+)[^\n]*-->[ \t]*\n([\s\S]*?)^[ \t]*<!-- box-safety:end -->/gm;
    const text = fs.readFileSync(f, "utf8");
    const begins = (text.match(/<!-- box-safety:begin/g) || []).length;
    let m, seen = 0;
    while ((m = re.exec(text))) {
      seen++; regions++;
      assert.ok(m[2].trim(), `${path.basename(f)}: block ${m[1]} is empty`);
      for (const t of KEY_TERMS[m[1]]) assert.ok(m[2].includes(t), `${path.basename(f)}: block ${m[1]} lacks "${t}"`);
    }
    assert.strictEqual(seen, begins, `${path.basename(f)}: a begin marker is not a standalone line`);
  }
  assert.ok(regions >= 12, `expected the rendered regions, found ${regions}`);
});

test("a begin marker with a list prefix is refused, not skipped", () => {
  assert.throws(() => R.render("- <!-- box-safety:begin ops-script -->\n<!-- box-safety:end -->", { "ops-script": "x" }, "f.md"), /malformed/);
});
