// A real, anonymized transcript corpus for the dispatch run-outcome classifier
// (task-spor-dispatch-transcript-classifier-real-fixture-corpus). The synthetic
// fixtures in dispatch-runs.test.js only ever encode what their author already
// believed the harness transcript format to be — a defect affecting 52 real
// sessions (cleanly-finished runs misread as vanished,
// inc-spor-dispatch-session-vanished-2026-07-18) was invisible to them and only
// surfaced when the classifier ran over the real transcript corpus. This suite
// runs transcriptOutcome() over real, anonymized transcript tails so the next
// harness record-type addition fails loudly here instead of silently
// misclassifying live runs. See test/fixtures/transcripts/README.md for what's
// anonymized and how to add a tail.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const runner = require("../lib/shell/agent-dispatch-runner.js");

const CORPUS_DIR = path.join(__dirname, "fixtures", "transcripts");
const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, "manifest.json"), "utf8"));

test("transcript corpus: manifest covers every checked-in fixture, and nothing else", () => {
  const fixtureFiles = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".jsonl")).sort();
  const manifestFiles = manifest.map((m) => m.file).sort();
  assert.deepStrictEqual(manifestFiles, fixtureFiles);
});

for (const entry of manifest) {
  test(`transcript corpus: ${entry.file} classifies as ${entry.expected.state}/${entry.expected.termination_signal}`, () => {
    const text = fs.readFileSync(path.join(CORPUS_DIR, entry.file), "utf8");
    const outcome = runner.transcriptOutcome(text);
    assert.strictEqual(outcome.state, entry.expected.state);
    assert.strictEqual(outcome.termination_class, entry.expected.termination_class);
    assert.strictEqual(outcome.termination_signal, entry.expected.termination_signal);
  });
}

test("transcript corpus: covers both outcomes plus a version spread, so a format shift is visible as a diff", () => {
  const states = new Set(manifest.map((m) => m.expected.state));
  assert.ok(states.has("done"), "corpus must include at least one cleanly-finished real tail");
  assert.ok(states.has("vanished"), "corpus must include at least one genuinely-vanished real tail");

  const versions = new Set();
  for (const entry of manifest) {
    for (const line of fs.readFileSync(path.join(CORPUS_DIR, entry.file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      if (rec.version) versions.add(rec.version);
    }
  }
  assert.ok(versions.size >= 2, `corpus must span more than one Claude Code version, saw: ${[...versions]}`);
});
