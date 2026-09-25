"use strict";
// prompt-context microDigest: the compact "Spor context" block the
// UserPromptSubmit hook injects (issue-spor-superseded-context-injected-as-live).
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert/strict");
const { microDigest } = require("../scripts/engines/prompt-context.js");

const HEAD = "Spor graph nodes relevant to this prompt (auto-compiled; run /spor:brief for a full briefing):\n\n";

test("microDigest keeps a superseded or settled status in the compact tag", () => {
  const out = microDigest(HEAD +
    "- **dec-a — Old cache** (decision, spor, 2026-01-01, superseded): Use redis.\n" +
    "- **dec-b — Cache policy** (decision, spor, 2026-01-02, settled): Use LRU.\n");
  assert.match(out, /^- dec-a: Old cache \(superseded\) — Use redis\.$/m);
  assert.match(out, /^- dec-b: Cache policy \(settled\) — Use LRU\.$/m);
});

test("microDigest drops a whole line rather than cutting off its trailing ⚠ note", () => {
  const long = "x".repeat(150);
  const out = microDigest(HEAD +
    `- **dec-a — First** (decision, 2026-01-01): ${long}\n` +
    `- **dec-b — Second** (decision, 2026-01-01): ${long} ⚠ RESOLVED by art-z — status field not yet updated, do not treat as open\n`,
    5, 320);
  assert.match(out, /dec-a/);
  assert.ok(!out.includes("dec-b"), "a line that doesn't fit whole is omitted, never truncated mid-line");
  assert.ok(Buffer.byteLength(out) <= 320);
});
