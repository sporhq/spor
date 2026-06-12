# REFACTOR.md — the kernel/shell split, the conformance suite, and the language question

Design record for the deep-refactor track: making Spor's behavior
language-independent now that viability is proven, with self-hosting as a
first-class requirement (dec-cc-spor-self-hosting-first-class — employer
dogfood approved, sensitive graph content). Companion to SPLIT.md (repo
topology + rename, in the private server repo); this doc covers what happens *inside* lib/ and where the
implementation language is allowed to vary.

Grounded in a 2026-06-12 scan of lib/ (17 modules, 4,384 lines).

## Principles

1. **Behavior outlives implementation.** The durable long-term-maintenance
   asset is not a language choice but a language-neutral conformance suite:
   golden fixtures of (inputs → outputs) for every kernel function, so any
   future port — Rust, or anything else — verifies against an oracle instead
   of a vibe. This generalizes norm-cc-byte-identical-refactor from a
   refactor-gate into a permanent artifact.
2. **JavaScript stays the extension and plugin language.** Schema verbs and
   lens `## custom` blocks are a product contract executed in QuickJS-in-wasm
   (dec-cc-wasm-sandbox-shipped) — host-language-agnostic by construction.
   The client plugin stays zero-dep readable JS (dec-cc-zero-dep-client):
   every target host ships Node, and auditability of installed agent code is
   a feature.
3. **Wasm is the portability boundary.** Precedent already set by the
   sandbox. If the kernel moves to Rust, it ships as wasm + thin JS bindings
   and runs identically in the server, the hook CLI, the future web renderer,
   and beside Automerge (itself a Rust core) when the CRDT store lands.
4. **Language decisions are made by experiment**, recorded as decision nodes,
   per house culture.

## 1. Kernel/shell split (the prerequisite for everything)

Scan result: **10 of 17 lib modules are already pure** (no fs/child_process):
`lens, viewtree, renderhtml, workspace, registry, resolution, routing, runs,
sandbox*, commit-inference`. (*sandbox is IO-free but host-capability-bound —
it stays a JS-engine concern either way, see Principle 2.)

Five modules mix IO; the IO is small and localized:

| Module | IO to extract | Kernel remainder |
|---|---|---|
| `graph.js` (529 ln) | `.md` dir reads at :38-39, :129-130, :393, :451-452 (loadGraph, seed load, brief read) | parseFrontmatter, two-arm compile, validators — the bulk |
| `queue.js` (419 ln) | one fs/os touch at :388-390 (activity journal) | rankQueue + signals — the bulk |
| `capture-metrics.js` (230 ln) | journal/jsonl reads :51, :142 | metric computation |
| `revert-oracle.js` (84 ln) | `execFileSync` git :25 | verdict logic over git output |
| `template.js` (29 ln) | file read :15 | interpolation |

`compile.js` / `validate.js` are CLI wrappers and remain shell by design.

**Mechanism:** kernel functions take data, not paths — loadGraph splits into
`readGraphFiles(dir) → {name: bytes}` (shell) and `buildGraph(files)`
(kernel); revert-oracle takes git output as input (the pattern
commit-inference already uses — its git calls live in scripts/, not lib/).
Layout: `lib/kernel/` (pure) + `lib/shell/` (fs/git/env adapters) + existing
entry points kept as façades so hooks, server, and wf/lenses see no path
changes. Requires no coordination with SPLIT.md's repo boundary — lib stays
whole and public.

**Verification:** byte-identical compile/validate against the live graph
(norm-cc-byte-identical-refactor), full client + server suites, wf lens
render byte-compare. This step is a pure refactor and must prove it.

## 2. Conformance suite

New top-level `conformance/`: fixture corpora (graph snapshots as plain file
maps) + expected outputs (compiled briefing text, queue rankings as JSON,
rendered view trees as JSON, validator diagnostics, runs-reducer transitions).
Format is language-neutral (JSON/text in, JSON/text out, frozen `now`).
Sources: the existing test fixtures, the Meridian example corpus
(dec-demo-vocab-in-fixtures), and a scrubbed snapshot of the live graph's
*shapes* (not content — employer-sensitivity discipline starts at home).

- Runner one: `node --test` over the JS kernel (replaces nothing; adds the
  oracle).
- Runner two (later): the same fixtures over any wasm kernel build.
- Allium: distill kernel obligations into specs alongside
  `specs/workflow-runs.allium` (in the private server repo) so the contract is
  recorded twice — executable fixtures + readable spec.

This suite is the deliverable that makes every later step cheap. It also
becomes the public repo's compatibility promise.

## 3. The Rust/wasm spike (bounded, decides the kernel-port question)

Port **`rankQueue` + queue signals** (kernel half of queue.js) to Rust,
compiled to wasm with JS bindings.
Why this module: pure after step 1, non-trivial logic, performance-relevant
(queue ranking runs server-side per request), existing test suite.

Success criteria, recorded as a decision node:
- Byte/JSON-identical on the full conformance fixtures.
- Perf: wall-clock vs Node on a large synthetic graph (target: meaningful win
  or at least parity with the ~60µs-class wasm call overhead absorbed).
- **Agent-iteration friction**: subjective but logged — edit-compile-test
  loop time, type-ceremony cost on the Claude-driven dev loop that builds
  this project. This is a first-class criterion, not a footnote.

If the verdict is positive, staged kernel port in dependency order:
parseFrontmatter/buildGraph → compile two-arm → queue → lens/viewtree/
renderhtml → runs reducer. Each stage gates on the conformance suite. JS
kernel remains the reference implementation until the wasm kernel has run a
full settling period in the server.

If negative: keep the JS kernel, keep the suite — nothing wasted; the suite
was the point.

## 4. The server and the self-hosting track

**API.md is the conformance boundary one level up** — any future server
reimplementation honors the REST/MCP contract, verified by the server test
suite repointed at a candidate. Server distribution (container image / single
executable / a possible Rust server) and the pilot's hardening story (LLM
egress and the data-flow map, auth/SSO, backup and ops, license/IP) are
designed in the private spor-server repo's docs, not here — this client repo
owns only the contract (API.md) those plans honor.

## 5. Sequencing (deep refactor prioritized, revised from SPLIT.md, in the private server repo)

1. Finish task-cc-node-port-hook-engines (in flight; rewrites the same files).
2. **Kernel/shell split + conformance suite** (§1, §2) — in place, before the
   rename/split, so the public repo is born with the clean layout and the
   suite.
3. Rename + repo split per SPLIT.md (in the private server repo; unchanged, now moves cleaner boundaries).
4. **Rust spike** (§3) → decision node → staged kernel port if positive.
5. Self-hosting hardening (§4) runs in parallel with 2-4 against the current
   Node server; container image and egress docs are not gated on anything
   above.

Steps 2-3 are the "couple of days" core. Step 4's spike is a day; the staged
port is only undertaken with the suite green and the spike verdict recorded.
