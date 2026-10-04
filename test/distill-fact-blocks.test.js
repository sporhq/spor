"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseFactBlocks } = require("../scripts/engines/distill.js");

test("parseFactBlocks drops whitespace-only blocks", () => {
  const r = "===FACT===\n   \n\n===END===\n===FACT===\nreal fact\n===END===\n===FACT===\n===END===\n";
  assert.deepStrictEqual(parseFactBlocks(r), ["real fact\n"]);
});

test("parseFactBlocks of only blank blocks is empty", () => {
  assert.strictEqual(parseFactBlocks("===FACT===\n \n===END===\n").length, 0);
});
