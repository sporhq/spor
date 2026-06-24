// Conformance suite wrapper — runs every golden case in conformance/ against
// the JS kernel via node --test (REFACTOR.md §2 "runner one"). The suite
// itself is language-neutral; this file is just its node:test harness, so a
// drifted golden fails CI the same way a unit test does.
//
// On failure: if the behavior change is INTENDED, regenerate with
//   node conformance/runner.js --update
// and review the expected/ diff like source. If it is not intended, the
// kernel broke its compatibility promise — fix the kernel, not the fixture.

require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { cases, runCase, expectedPath } = require(path.join(__dirname, "..", "conformance", "runner.js"));

for (const c of cases()) {
  test(`conformance: ${c.id} (${c.kind})`, () => {
    const file = expectedPath(c);
    assert.ok(fs.existsSync(file), `expected/${c.expected} missing — run conformance/runner.js --update`);
    const want = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const got = runCase(c);
    assert.equal(got, want, `${c.id} drifted from its golden (covers: ${c.covers ?? "?"})`);
  });
}
