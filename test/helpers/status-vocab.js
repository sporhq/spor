// Single hand-written source for each seed type's status vocabulary, shared by
// test/seed-status-vocab.test.js and test/registry.test.js so a seed
// vocabulary change needs exactly ONE test-side edit instead of two hand-synced
// copies drifting apart silently (task-spor-status-vocab-drift-guard, following
// issue-spor-off-vocab-artifact-statuses).
//
// Deliberately NOT derived from lib/seed/: reading the seed schemas back here
// would make these tests tautological — a bug in a schema's validate() gate
// and the test that's supposed to catch it would drift together. `valid` need
// not be exhaustive (some consumers only probe a subset); `bad` is the union of
// off-vocabulary statuses every consumer needs rejected.
const STATUS_VOCAB = {
  task: {
    valid: ["open", "active", "done", "abandoned"],
    bad: ["in_progress", "doing", "closed", "dismissed", "wip", "resolved", "merged"],
  },
  issue: {
    valid: ["open", "active", "resolved"],
    bad: ["in_progress", "done", "closed", "dismissed", "fixed"],
  },
  decision: {
    valid: ["active", "superseded", "rejected", "settled"],
    bad: ["dismissed", "declined", "open", "done", "resolved"],
  },
  question: {
    valid: ["open", "answered"],
    bad: ["resolved", "closed", "answered!", "done", "dismissed"],
  },
  "capture-pending": {
    valid: ["merged", "rejected"],
    bad: ["dismissed", "resolved", "closed", "pending", "done"],
  },
  correction: {
    valid: ["active", "applied"],
    bad: ["dormant", "retired", "done", "resolved"],
  },
  // artifact is validate()-ONLY (no transitions() gate — the delivery stages
  // are not a state machine, a change may be born `merged`); see
  // issue-spor-off-vocab-artifact-statuses for the census this vocabulary
  // closes the gap on.
  artifact: {
    valid: ["in-review", "approved", "merged", "released", "done", "active"],
    bad: ["complete", "shipped", "landed", "resolved", "open", "wip", "abandoned"],
  },
};

module.exports = { STATUS_VOCAB };
