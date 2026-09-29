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
  - `grammar` — the node-file grammar itself (lib/kernel/frontmatter.js,
    task-spor-client-single-frontmatter-parser): every edge shape (flow with
    attributes and the `target:` alias, block form opened by any key,
    comments/blank lines, alias and inverse spellings, a flow edge outside the
    block), every list shape (inline, indented/flush-left/empty block, a stray
    line, a list key holding a scalar), quoted and folded scalars, duplicate
    keys, `repo:` beating `project:`, a CRLF file (`.gitattributes` pins
    its bytes), a fenceless file and the two deliberate edge faults. The
    `grammar-frontmatter` case pins the strict read, the lenient lex (line
    ranges, recorded faults), the canonical serialization and the round-trip
    law; `grammar-edits` pins the structure-aware editors (edge add/remove,
    stamp, key set) to the byte.
  - `unicode` — a small multilingual compile corpus (Swedish, Norwegian/
    German, Japanese, and an English control whose only non-ASCII characters
    are separators) for the Unicode-aware tokenizer
    (lib/kernel/tokenizer.js, task-spor-unicode-slugify-and-tokenizer): the
    `unicode-query-*` cases pin that a diacritic query, the same query typed
    without accents, non-decomposing letters (ø æ ß) and unspaced Japanese
    all seed the right node. The tokenizer's own edge-case corpus is the
    corpus-less `tokenizer-unicode` case: its input strings ARE the fixture.
  - The content arm's tf-idf index and cosine ranker (lib/kernel/ranker.js,
    task-spor-compile-explicit-pipeline-and-ranker-extraction) likewise has a
    corpus-less case, `ranker-tfidf`: inline docs + queries pin the index
    (N, per-doc norm, df) and every query's full ranking — prototype-key
    tokens, zero-norm docs, unknown/empty queries, excludes — then the
    incremental `indexNode` update/create path re-ranked. Sims are rounded to
    12 significant digits.
  - `meridian` — the self-contained example org from wf/lenses/examples
    (dec-demo-vocab-in-fixtures): graph-resident schema vocabulary, lenses,
    workspaces.
  - `live-shape` — a structure-preserving, content-free scrub of the live
    dogfood graph (343 nodes) for behavior at scale; regenerate with
    `tools/scrub-live-graph.js` (review output before committing — shapes,
    not content).
- `cases/<id>.json` — one pinned invocation each: `kind`
  (compile | skeleton | queue | validate | frontmatter | frontmatter-edit |
  tokenizer | ranker | viewtree | queue-viewtree | runs),
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
