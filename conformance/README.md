# Conformance suite — the kernel's compatibility promise

Language-neutral golden fixtures for the pure kernel (`lib/kernel/`):
graph snapshots in, briefing/ranking/viewtree/diagnostics/run-transitions
out, byte-for-byte. This is the permanent oracle from
dec-cc-lib-kernel-io-split — any future kernel implementation (Rust/wasm or
anything else) is correct exactly when it reproduces every file in
`expected/` from the corpora and cases here. It generalizes
norm-cc-byte-identical-refactor from a refactor gate into a standing
artifact (REFACTOR.md §2).

## Layout

- `corpora/<name>/nodes/*.md` — fixture graphs as plain files.
  - `pricing` — hand-written compile corpus: supersession, corrections
    (pin/exclude, global), norms ride-along, questions.
  - `queue` — hand-written ranking corpus: blocks chains, resolves
    retirement, staleness, mutes, findings, capture-pending.
  - `queue-policy` — `queue` plus org schema nodes: attached
    `queueSignals()` code, a `queue-policy` `rank()` override, and a
    proposed schema awaiting approval.
  - `cold-neighbors` — a cold node in a moving neighborhood, ranked with a
    pinned git-derived `timestamps` index injected via the case input (the
    corpora carry no git history). The paired `cold-neighbors-scored` /
    `cold-neighbors-absent` cases lock that `cold_neighbors` is
    surfaced-not-scored (dec-spor-cold-neighbors-suggestion-only): injecting
    the index adds the signal + why-line on the cold node but leaves every
    score identical (0 weight).
  - `diagnostics` — deliberately broken corpus covering every validator
    error and warning class.
  - `meridian` — the self-contained example org from wf/lenses/examples
    (dec-demo-vocab-in-fixtures): graph-resident schema vocabulary, lenses,
    workspaces.
  - `live-shape` — a structure-preserving, content-free scrub of the live
    dogfood graph (343 nodes) for behavior at scale; regenerate with
    `tools/scrub-live-graph.js` (review output before committing — shapes,
    not content).
- `cases/<id>.json` — one pinned invocation each: `kind`
  (compile | skeleton | queue | validate | viewtree | queue-viewtree | runs),
  `corpus`, `input`, `expected`, and a `covers` note.
- `expected/` — the goldens. Treat diffs here like source diffs in review.
- `runner.js` — runner one: the JS kernel. `--update` regenerates goldens,
  `--case <id>` runs one, `--list` lists. `test/conformance.test.js` wraps
  the same cases for `node --test`.

## The contract a port must honor

1. Corpus files are presented to the kernel in **lexicographic filename
   order** (readdir order is filesystem-dependent and not part of the
   contract).
2. The **seed schema pack** (`lib/seed/`) is an input alongside the corpus
   and is versioned with the suite: changing the seed legitimately changes
   goldens.
3. **`now` is always pinned** by the case (ISO 8601 → epoch ms). The kernel
   never reads a clock; `Date.now()` defaults in kernel signatures are
   host-injection points that conformance never exercises.
4. JSON outputs serialize with 2-space indent, keys in construction order,
   trailing newline. Text outputs are byte-exact, including the pinned
   `nodesDir` (`/graph/<corpus>/nodes`) echoed in digest headers.
5. Attached schema code (`queueSignals`, queue-policy `rank`) executes under
   the sandbox contract — no clock, no randomness, JSON boundary
   (spec-cc-wasm-sandbox). The engine itself is host-supplied (this runner
   uses lib/sandbox.js, the server uses wasm); identical observable results
   are required.
6. `compile` maps `relevant: false` to empty output and an unknown root to
   the literal line `UNKNOWN ROOT`.

## Updating

A golden change is a **behavior change** and gets reviewed as one:
regenerate with `node conformance/runner.js --update`, read the diff, and
say in the commit why the behavior moved. Never hand-edit `expected/`.
Adding coverage = new corpus/case + `--update` for its golden.

Not yet covered (welcome additions): workspace composition
(`runWorkspace`), routing (`routeQuestion`/`routedOpen` — carries an inline
`Date.now()`), renderhtml output, capture-metrics, commit-inference scoring.
