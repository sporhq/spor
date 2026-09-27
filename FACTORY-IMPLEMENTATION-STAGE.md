# FACTORY-IMPLEMENTATION-STAGE.md — implementation as a first-class factory stage

Design record for task-spor-factory-implementation-stage, derived from
art-spor-dartlane-factory-pilot-review-2026-09-05. It specifies an OPTIONAL
`implementation:` stage on a factory definition, the **candidate** object a
stage produces, the lifecycle that ends in a controller-written completion,
and the migration that gets there without an adoption cliff.

**Status: design record, reconciled 2026-09-27 against the shipped contracts
(task-spor-reconcile-implementation-stage-design-source).** This text was
written at e18e2c9 on the unmerged `task-spor-factory-implementation-stage`
branch, before any of it was built. Most of §8 has since shipped. The
NORMATIVE contract is now WORKERS.md §10.12-§10.16 (candidate, controller
completion, the declared blocks, the execution store and the stage runner),
the kernels they name (`lib/kernel/gates.js`, `candidate.js`, `completion.js`,
`execution.js`) and, for the hosted half, spor-server's EXECUTION-STATE.md.
Where this document and those disagree, the shipped contract wins. §11 lists
every such divergence found in the reconciliation, and each is also marked
inline with **Reconciled:**. §11 also adjudicates the review findings F1, F2
and F11-F17 against what shipped and maps the five design acceptance points
to their sections. Divergences not listed in §11 are still "not built yet",
never a WORKERS.md error. No schema in `lib/seed/candidates/` is changed by
this document, and no schema is activated by it.

Grounded in a read of Spor 0.28.x at this commit: `lib/kernel/gates.js`
(`parseFactory`/`parseIntegration`/`parseRescue`, `GATE_DEFAULTS`,
`SETTLED_GATE_STATES`), `lib/shell/work-loop.js` (`runWorkLoop`, `shouldGate`,
`runHarvest`, `orphanedGateRuns`), `lib/shell/gate-runner.js` (`judge`, the
per-gate fix-cycle loop, `readChanged`), `lib/shell/integration-runner.js`,
`lib/shell/worker-contract.js`, `lib/shell/dispatch-harnesses.js`
(`normalizeHarnessDeclaration`, `declaredAdapter`), `bin/spor.js`
(`dispatchWorkItem`, `dispatchThrough`, `pollWorkRuns`, `makeGateDeps`,
`runGateAndIntegration`, `gateDemoteItem`, `setStatusLocal`, `appendEdgeLine`,
`gitBlobSha`), API.md §1/§3 (`put_node` with `revision`, `add_edge`,
`remove_edge` / `DELETE /v1/nodes/{id}/edges`), and WORKERS.md §6-§10.

Four facts of the shipped code that this design is written AGAINST, because
an earlier draft got each of them wrong:

- `--run-max` / `--run-idle` are parsed ONCE in `cmdWork` and applied by
  `pollWorkRuns` at every poll as worker-global ceilings; `cmdDispatch` takes
  neither. A per-stage budget therefore cannot ride a dispatch flag (§5.1).
- A fix cycle re-runs only the gate that failed (`judge` in gate-runner.js
  loops per gate; earlier passed gates keep their verdicts); a rescue pass
  re-runs the whole list. The candidate chain (§3.3) and the dispatch bound
  (§5.4) are written to that, not to a from-gate-0 restart.
  **Reconciled (D7):** that fact did not survive. The gate attestation work
  (WORKERS.md §10.10 "every step judges the same head") made a fix cycle that
  moves the head restart the pipeline from gate 0. A gate whose recorded pass
  already judged the current head stands, and fix cycles are charged
  cumulatively against each gate's cap across restarts. §3.3's tip rule and
  §5.4's bound are realized by that restart, not by a separate G9 step.
- The client HAS an edge door in both directions: `add_edge` and `remove_edge`
  (`DELETE /v1/nodes/{id}/edges`, API.md §3) in remote mode, and an in-place
  frontmatter rewrite (`appendEdgeLine`'s twin) in local mode. WORKERS.md §10.7
  chooses not to retract under the `by: agent` contract because the resolver is
  the agent's evidence; under `by: controller` the resolver was never allowed to
  carry the edge, so §4.5 retypes it. The one CAS door is `put_node` with
  `revision` (API.md §1: "no silent last-write-wins"); `set_status` and the
  edge micro-mutations are server-side read-modify-write with no revision —
  and an item's `revision` does NOT move when a resolving edge is added on
  some OTHER node (inbound edges live on the source file), so a CAS on the
  item alone cannot observe a foreign resolver (§4.3).
- Queue liveness has exactly TWO halves, both pure kernel functions the server
  consumes through the shared `lib/`: the EDGE half, `resolutionMap` in
  `lib/kernel/resolution.js` (an item with a live inbound `resolves`/`answers`
  is retired — queue.js:541/:761, graph.js:1237, program.js:23, analytics.js),
  and the STATUS half, `isLive` in `lib/kernel/queue.js` (a terminal `status`
  is dead — `blockingCount`, `liveBlockers`, `directLiveBlocks`,
  `deriveReadiness`, `rankQueue` and program.js:23 all go through it). A
  dependent is released when its blocker fails EITHER half. A rule added to
  BOTH is enforced on every read surface in BOTH modes at once — which is why
  the premature-resolution window can be closed on the READ side (§4.5's
  execution hold, applied to both halves) rather than only bounded by a poll.
  An earlier draft of the hold covered only the edge half; a `set_status
  done` by the implementer walked straight through the status half, which is
  the F1 window under another name.

---

## 1. What is wrong today, in one paragraph each

**Implementation is the one stage nobody declared.** `spor work` claims an
item and hands it to `dispatchWorkItem` (bin/spor.js), which builds a dispatch
from the worker's own `--profile` passthrough, the item's `profile:`
frontmatter, and a hardcoded prompt (`workerContract()`). Its budget is the
worker's, not the factory's (`work.runMaxMs` 24h, `work.runIdleMs` 45min), and
its only retry is `work.retryAfterMs` — a machine-local cooldown, not an
attempt. So the one step that actually writes the code is the only step of the
pipeline that a factory cannot describe, while every judging step (gates,
integration, rescue) is declared data.

**The graph is told "done" before anything checked.** `workerContract()` step 5
instructs the implementer to write a resolver node and flip the item's terminal
status. §6's terminal contract then verifies that edge, and only then does
`shouldGate` start the gates. Between those two moments the item carries a live
`resolves` edge, and queue liveness is derived from the EDGE
(`lib/kernel/queue.js` retires a node with a live inbound `resolves`/`answers`
whatever `status` says) — so **every dependent of that item is released by a
claim no gate has judged yet**, and stays released if the gates then refuse.
§10.7's demotion exists to paper over this: it rolls the status back and files a
`blocks`-carrying escalation, because under the `by: agent` contract the
resolver is the agent's evidence and the runner will not retract it. In the
pilot, efd3b3d4's 16 implementations were all resolved before acceptance; nine
passed, two failed and five were still gating when the worker died.

**Author checks are prescribed twice.** `workerContract()` maps EVERY command
gate into the implementer's prompt ("the factory's acceptance command (…),
which the gate re-runs from the trusted ref's copy"). The pilot's implementers
therefore ran expensive browser suites that the factory then ran again from the
trusted ref, on hardware whose only concurrency control counts runs, not
suites.

**An outage is charged to the code.** A dispatch that fails because the API was
down, a reviewer whose harness never started, a token mint that 401s — all of
them arrive at the runner as "this gate did not pass", spend a fix cycle at a
change that was never wrong, then a rescue, then a person
(issue-spor-review-gate-reviewer-outage-read-as-rejection).

**There is no candidate.** What the gates judge is re-derived on each pass from
the run's own working tree (`merge-base(trusted_ref, HEAD)..HEAD` in
`record.cwd`). Nothing is pinned, nothing is portable, and when
`dispatch.worktree` was not enabled the pilot's three agents shared
`/home/exedev/dartlane` and interleaved their changes on `main` — a tree that no
later reader could attribute to any one run.

---

## 2. The `implementation:` block

### 2.1 Shape

A stage, not a fourth gate kind — the same argument `integration:` settled
(dec-spor-factory-integration-step): a gate JUDGES a candidate, a stage
PRODUCES or MOVES one. It parses beside `gates` on the same factory payload,
with its own vocabulary, in a new pure `parseImplementation(payload)` in
`lib/kernel/gates.js`.

```json
{
  "factory": "spor-default",
  "trusted_ref": "main",
  "repos": ["spor"],
  "protected_paths": ["test/**", "conformance/**"],
  "test_lane_profile": "profile-test-writer",
  "implementation": {
    "profile": "profile-implementer",
    "instructions": "Prefer the smallest change that makes the acceptance suite honest.",
    "author_checks": ["typecheck"],
    "budget": { "run_max_ms": 5400000, "run_idle_ms": 2700000, "attempts": 1 },
    "retry": { "attempts": 1, "backoff_ms": 60000 },
    "candidate": { "require_clean": true, "publish": "bundle" }
  },
  "completion": { "by": "controller", "after": "integration" },
  "gates": [
    { "id": "typecheck", "kind": "command", "command": "npm run typecheck", "timeout_ms": 300000 },
    { "id": "acceptance", "kind": "command", "command": "npm test", "timeout_ms": 900000 },
    { "ref": "gate-adversarial-review", "cycles": 2 }
  ],
  "integration": { "mode": "local", "command": "npm test", "target_ref": "main" }
}
```

| key | type | default | why that default |
|---|---|---|---|
| `implementation` | object | **absent** | Absent is the routing/budget half of the back-compat guarantee: no block ⇒ `parseImplementation` returns `{implementation: null, errors: []}` and every routing, budget and candidate-publication path below is inert, exactly as `parseIntegration`/`parseRescue` behave for a factory that declares neither. (The prompt's completion step is governed by `completion.by`, below — see §6.1 for exactly what "legacy" means.) |
| `.profile` | string | `""` | Empty keeps today's routing untouched. When set it is the LOWEST-precedence router (§2.3), so declaring a lane never overrides a per-item routing decision. |
| `.instructions` | string | `""` | Appended to the contract, never replacing it: a factory may add lane guidance, but the commit-before-you-submit discipline is the runner's, not an operator's to delete. |
| `.author_checks` | string[] of gate ids | `[]` | **No expensive suite is prescribed twice.** The gate re-runs from the trusted ref regardless, so an author run of the same suite is pure duplicate spend; naming a cheap gate (a typecheck, a lint) buys an early failure at a price worth paying, and the operator makes that call per gate. Legacy (no block) keeps today's "every command gate" mapping so existing factories are byte-identical. |
| `.budget.run_max_ms` | int ms | inherit `work.runMaxMs` (24h) | The factory knows its lane's shape better than the worker's global ceiling does, but a factory that says nothing must not silently shorten a worker's watchdog. Applied per RUN RECORD by the loop's poll, never as a dispatch flag (§5.1). |
| `.budget.run_idle_ms` | int ms | inherit `work.runIdleMs` (45min) | Same; `0` disables idle detection for a lane whose steps genuinely run that long (WORKERS.md §8). |
| `.budget.attempts` | int 1..3 | `1` | The **code** pool (§5.3). A second implementation attempt at the same item with the SAME prompt is the least informative retry available — the fix cycle, which carries the findings, is the mechanism that differs. So re-implementation is opt-in and capped at 3. |
| `.retry.attempts` | int 0..3 | `1` | The **infrastructure** pool (§5.3), ONE pool per pipeline shared by every dispatch the pipeline makes (implementation, review, fix, rescue), so an outage during a review cannot multiply the bound (§5.4). One retry covers a blip; a real outage outlives any backoff, and the item's cooldown plus the next poll is the honest remedy. |
| `.retry.backoff_ms` | int ms 1000..600000 | `60000` | One minute is long enough to clear a transient auth/rate refusal and short enough that a worker's slot is not parked on a guess. |
| `.candidate.require_clean` | bool | `true` | A gate already refuses a tree with uncommitted TRACKED changes (§10.3). Checking it at submission moves the refusal one step earlier, where the dirty-tree round-trip already lives, instead of discovering it inside the first gate. |
| `.candidate.publish` | `bundle`\|`branch`\|`both` | `bundle` | **A candidate always carries a portable reference; there is no `none`.** `bundle` is the default because it is the only form that needs no credential and no network: `git bundle create` of `base.merge_base..commit` into the bundle store — a self-contained, content-verified object (§3.4). It costs one local git command per submission. `branch` pushes an immutable candidate ref to a remote and needs write access to it; `both` publishes both forms (a hosted deployment that wants a fetchable ref beside the stored bytes). The machine-local workspace path is recorded as PROVENANCE (`provenance.cwd`, §3.1), never as the reference. |
| `.candidate.remote` | string (URL, or a git remote name resolved to its fetch URL at publish) | `"origin"` | Only read under `publish: branch`/`both`. A remote NAME is machine-local, so what the candidate RECORDS is the resolved URL (§3.4); the name is only how the operator points at it. |
| `.candidate.bundle_store` | string (URI prefix, `file://` or `https://` only) | local mode: `file://<SPOR_HOME>/candidates`; remote mode: the server's candidate door (`https://<server>/v1/executions/{execution_id}/candidates`, §7.5) | Where a bundle is put so that a reader can `GET` it by locator. The local default is machine-local state under the graph home (added to the shared-graph `.gitignore` list beside `/journal/`, since bundles are binary artifacts): the OBJECT is portable — copy the file anywhere and it verifies — and how far the LOCATOR reaches is the operator's deployment fact (a shared filesystem, or a `file://` path on a mount), declared by overriding this key. `https://` is the hosted store. No other scheme — a zero-dependency client cannot sign object-store requests, and the design refuses at parse rather than at the first publish. `spor work` refuses at startup a store it cannot write to (E9's sibling check). |
| `completion` | object | `{by: "agent"}` when no `implementation:` block, else `{by: "controller"}` | The block is the opt-in. A factory that adopts a declared implementation stage has asked for the stage's semantics, of which "the controller writes completion" is the load-bearing one; a factory that declares neither key is untouched. |
| `completion.by` | `agent`\|`controller` | see above | `agent` is today's behavior (the implementer writes the resolving edge and the status). `controller` is §4.3. |
| `completion.after` | `gates`\|`integration` | `integration` when an `integration:` block is declared, else `gates` | The boundary must be REACHABLE. Defaulting to the last stage the factory actually declares means a factory with no integration still completes, which is acceptance criterion 2's "factories without an integration stage". `gates` with an integration block declared is VALID and means "complete on acceptance, then land": integration runs AFTER the completion write (§4.2 rows C1-C4) and its failure cannot un-complete the item. That is an operator's explicit choice to release dependents before the change is on the target ref, and the default when integration is declared is the safer boundary. |
| `gates[].rejudge_on_repin` | bool (command gates only) | `true` under `completion.by: controller`; not read under `by: agent` | **Acceptance is a property of the TIP** (§3.3): the controller's completion write asserts that every gate passed the candidate it completes, and a verdict on an ancestor tree is not that. So by default a command gate whose pass is on an ancestor is re-run on the tip at G9 — a suite run, never a dispatch, so it changes no dispatch bound (§5.4). `false` is an explicit, startup-logged opt-out for a suite the operator accepts standing on an ancestor for (the shipped stand-on-the-ancestor rule, WORKERS.md §10.4). Agent-review gates carry no knob: a review ALWAYS re-judges a moved tip (E13, §3.3) — independent review of what is accepted is not an operator's to relax. |

**Reconciled (D3), `candidate.bundle_store`'s default:** as shipped
(`defaultBundleStore` in lib/shell/candidate-publish.js), the default is
`file://<userConfigHome>/candidates` in BOTH modes. That is this machine's
personal env home. It is never a `graph:`-marker shared home, because binary
bundles must not ride a shared repo's git flow
(task-spor-candidate-store-home-vs-shared-graph-home-trap). The `.gitignore`
line is written wherever the store actually resolves
(`ensureStoreGitignore`), not appended to the graph home's list. The remote
default this row names (the server's candidate door) needs an execution id to
form its URL, and the client did not have one when publication shipped. So
remote mode takes the same machine-local store, and an operator who wants
further reach declares `bundle_store`. The object is portable either way.
Every other default in this table matches `parseImplementation` and
`GATE_DEFAULTS` (lib/kernel/gates.js): `retry.backoff_ms` is 60000, `attempts`
1, `retry.attempts` 1 (0..3), and so on. A value that cannot be read as a
number takes the documented default rather than the floor (`countOr`,
`msOrInherit`). A readable value out of range clamps.

### 2.2 What the block may NOT contain

No `command`, `args`, `argv`, `bin`, `exec`, `entrypoint`, `env`, `report`,
`session`, `launch_mode` or `identity_mode`. The rule is
dec-spor-declarative-harness-machine-binds-execution, already enforced for
profiles (`sat.GRAPH_LAUNCH_FIELDS`) and already kept by `agent-review` gates and
the `rescue:` block: **a graph write must never define what a machine executes.**
An implementation stage routes by PROFILE; the machine's own
`dispatch.harness.<id>` declaration decides what that runs (§5). Any of those
keys present is a parse error naming the key — not a silent drop, because a
factory author who wrote `command` believes it is doing something.

### 2.3 Profile routing precedence

Unchanged at the top, extended at the bottom. High-first:

1. an explicit CLI `--profile` on the worker (`resolveDispatchProfile`'s
   explicit-beats-inferred rule);
2. the item's own `profile:` frontmatter — the test-change lane's self-routing
   (§10.3) exists precisely to send one item somewhere else, and a factory
   default that overrode it would defeat the lane;
3. the item's `assigned -> agent` edge;
4. **`implementation.profile`** — the factory's lane default;
5. nothing: today's unrouted dispatch.

The stage never SUBSTITUTES on unsatisfiability. A box that cannot satisfy the
resolved profile refuses loudly and leaves the assignment and lease intact,
exactly as `spor dispatch --profile` does today.

### 2.4 Validation table

`parseImplementation` returns `{implementation, completion, errors}`; a
non-empty `errors` refuses to start the worker, joining the existing fatal list
in §10.1. A mistyped stage must never produce a worker that dispatches
unbudgeted.

| # | payload fragment | verdict |
|---|---|---|
| V1 | no `implementation` and no `completion` key | valid — `null`/`{by: "agent"}`, byte-identical to today (§6.1) |
| V2 | `{"implementation": {}}` | valid — every default in §2.1 applies; `completion.by` becomes `controller` |
| V3 | `{"implementation": {"author_checks": ["typecheck"]}}` with a `typecheck` command gate | valid |
| V4 | `{"implementation": {"budget": {"attempts": 3}}, "completion": {"by": "controller", "after": "gates"}}` | valid |
| V5 | `{"implementation": {"candidate": {"publish": "branch", "remote": "origin"}}}` | valid |
| V6 | `{"completion": {"by": "controller", "after": "gates"}}` WITH an `integration:` block | valid — the item completes at acceptance and integration runs after it (§4.2 C1-C4); the worker logs the boundary it will use at startup so the choice is visible |
| V7 | `{"implementation": {"candidate": {"publish": "bundle", "bundle_store": "file:///srv/spor/candidates"}}}` | valid — a shared-filesystem store |
| V8 | `{"implementation": {"candidate": {"publish": "bundle"}}}` with no `bundle_store` | valid — the store defaults per mode (§2.1) |
| V9 | `{"gates": [{"id": "acceptance", "kind": "command", "command": "npm test", "rejudge_on_repin": false}]}` | valid — the opt-out; the worker logs at startup that `acceptance` may stand on an ancestor tree |
| E1 | `{"implementation": []}` | error: `implementation: must be a JSON object` |
| E2 | `{"implementation": {"command": "npm run agent"}}` | error: `implementation: 'command' is not declarable in the graph — route by 'profile' and bind the harness on the machine (dispatch.harness.<id>)` |
| E3 | `{"implementation": {"author_checks": ["nope"]}}` | error: `implementation.author_checks names 'nope', which is not a declared gate id` |
| E4 | `{"implementation": {"author_checks": ["adversarial-review"]}}` (an agent-review gate) | error: `implementation.author_checks may name command gates only — 'adversarial-review' is an agent-review gate` |
| E5 | `{"implementation": {"budget": {"attempts": 9}}}` | clamped to 3 by `intOr`'s `max` — the existing convention for a bounded count (`cycles`, `reruns`), not an error |
| E6 | `{"implementation": {"retry": {"attempts": -1}}}` | clamped to 0 |
| E7 | `{"completion": {"after": "integration"}}` with no `integration:` block | error: `completion.after 'integration' but no integration stage is declared — the completion boundary would never be reached` |
| E8 | `{"completion": {"by": "nobody"}}` | error: `completion.by 'nobody' must be one of: agent, controller` |
| E9 | `{"implementation": {"candidate": {"publish": "branch"}}}` with no `remote` and no `origin` in the checkout | **deferred, not a parse error** — a parse cannot read a checkout; refused at worker startup beside the `gh`-capability check `integrationSatisfiability` already performs for `mode: propose` |
| E10 | `{"completion": {"by": "controller"}}` with NO `implementation:` block | valid, and deliberately so: an operator may adopt the completion boundary alone. It is NOT byte-identical — it changes the prompt's completion step to candidate submission (§6.1) and arms the controller's completion write (§4.3); routing, budget and publication stay at their defaults. |
| E11 | `{"implementation": {"candidate": {"publish": "none"}}}` | error: `implementation.candidate.publish 'none' must be one of: bundle, branch, both — a candidate always carries a portable reference (§3.4)` |
| E12 | `{"implementation": {"candidate": {"publish": "bundle", "bundle_store": "s3://bucket/x"}}}` | error: `implementation.candidate.bundle_store must be a file:// or https:// URI — 's3://' cannot be reached without a signing dependency` |
| E13 | `{"gates": [{"ref": "gate-adversarial-review", "rejudge_on_repin": true}]}` (an agent-review gate; `false` is refused the same way) | error: `rejudge_on_repin is not declarable on an agent-review gate — a review always re-judges a moved tip (§3.3)` |
| E14 | `{"implementation": {"candidate": {"publish": "bundle", "bundle_store": "https://x/"}}}` in LOCAL mode | error at worker startup (not parse): `bundle_store 'https://…' needs a Spor server — local mode has no candidate door; use file://` |

---

## 3. The candidate

**A candidate is a pinned commit plus the tree it resolves to, plus
provenance, plus a reference something other than this process can follow. It
is never an agent's claim of resolution.** This is the object the pilot had no
name for, and the one the hosted execution store persists (§7).

### 3.1 Shape

```json
{
  "candidate_id": "cand-3f9a1c72e5b40d16",
  "spec_version": 1,
  "repo": "spor",
  "node_id": "task-spor-factory-implementation-stage",
  "commit": "4c1b7d0f8a2e5b91c3d6f04a7e8b2c19d5a6f3e0",
  "tree": "a91c5d3f70b2e846c1d9f5a30b7e2c684d1f9a35",
  "base": { "ref": "main", "commit": "e8d3091…", "merge_base": "e8d3091…" },
  "branch": "task-spor-factory-implementation-stage",
  "commits_seen": [],
  "clean": true,
  "changed_paths_sha256": "…",
  "supersedes": null,
  "submitted_by": { "stage": "implementation", "cycle": 0, "rescue": 0 },
  "provenance": {
    "run_id": "0f2c…", "attempt": 1, "pool": "implementation",
    "harness": "claude-code", "profile": "profile-implementer",
    "agent": "agent-anthony-shark-november", "worker": "fe24cc97",
    "machine": "shark-november", "cwd": "/…/.claude/worktrees/…",
    "started_at": "2026-09-05T09:00:00Z", "finished_at": "2026-09-05T09:41:12Z"
  },
  "reference": {
    "kind": "bundle",
    "store": "file:///home/exedev/.spor/candidates",
    "key": "cand-3f9a1c72e5b40d16.bundle",
    "locator": "file:///home/exedev/.spor/candidates/cand-3f9a1c72e5b40d16.bundle",
    "commit": "4c1b7d0f8a2e5b91c3d6f04a7e8b2c19d5a6f3e0",
    "sha256": "…", "bytes": 48213,
    "published_at": "2026-09-05T09:41:20Z", "verified_at": "2026-09-05T09:41:21Z"
  },
  "resolver": { "node": "dec-…", "written": true, "resolves_edge": false }
}
```

`provenance.cwd` is where the commit was made; it is provenance, not a
reference — nothing in the pipeline follows it, and a controller on another
machine never sees it as a way to obtain the commit. The `reference` is the
only door (§3.4), and a candidate is not SUBMITTED until it has one that
verified.

### 3.2 Identity: content-addressed on what is judged

**`candidate_id` = `cand-` + first 16 hex of `sha256(repo, node_id, tree)`.**
Nothing else goes into the key — not the commit, not the attempt, not the run.
The `tree` is the content a gate judges; the commit is one of possibly several
labels on it. So:

- an amend that changes only the message, a retry that re-commits the same
  files, a rebase that happens to reproduce the same tree, all yield the SAME
  candidate and hit the same idempotent facts (the capture-nudge convention,
  `capture_key`, applied to trees instead of findings);
- a rebase onto a moved trusted ref changes the tree and IS a new candidate —
  correctly, because the merged-in base is content the gates have not judged;
- two candidates with the same tree for different items are different
  candidates (the item is in the key), and the same tree in two repos is too.

`commit`, `provenance` and `submitted_by` are FIELDS of the candidate, not its
identity — and **the pinned `commit` is immutable once the candidate is
published: first published wins.** A re-submission of an existing
`candidate_id` with a different commit (an amend, a same-tree re-commit)
appends the new commit to `commits_seen` and changes NOTHING else: not
`commit`, not `reference`, not the published object. It never mints a second
candidate for content already judged, and it never re-publishes. This is what
lets the published ref/bundle be keyed by `candidate_id` AND immutable (§3.4)
without contradiction: one candidate, one pinned commit, one object.
Everything downstream consumes the PINNED commit, never the branch head —
gates judge the tree; integration merges `reference.commit` into
`target_ref` (item 2 in §8 changes `runIntegrationStage` from "the branch in
`record.cwd`" to the tip candidate's pinned commit), and the `art-merge-*`
fact names it. A head that is a same-tree relabel of the pinned commit is
therefore not what lands — its tree is, under the commit that was published,
which is the only thing another machine could ever have fetched.

### 3.3 The chain: a candidate is superseded, never mutated

HEAD moves after submission — a fix cycle commits, a rescue amends, an
integration fix cycle commits again — and a candidate that stays pinned to the
first commit would be a record of something the gates are no longer judging.
So **every run that commits under the pipeline re-pins**: `pinCandidate` runs
at the same point the shipped runner already re-reads the tree (`readChanged()`
after every fix cycle; the rescue pass's fresh read; the integration runner's
"refresh before each cycle", issue-spor-integration-stale-head-across-fix-
cycles). The new candidate carries `supersedes: <prior candidate_id>` and
`submitted_by: {stage: "fix"|"rescue"|"integration-fix", cycle, rescue}`; the
run record's `impl_candidate` is the TIP and `impl_candidates` is the
append-only chain (§6.5).

What each existing verdict then means, with the shipped semantics kept:

- **A gate fact records the candidate it judged** (`candidate_id` on every
  `art-gate-*`, `art-rescue-*` and `art-merge-*` fact). A fact is immutable;
  the chain says which are on the tip.
- **A fix cycle re-judges only its own gate on the NEW candidate** — this is
  what `judge` does today, and the review's stateful protocol (prior findings by
  ledger id, the last fix's commits) already assumes the tree moved.
- **Acceptance is a property of the tip.** A gate's verdict names the
  candidate it judged, and at G9 every gate whose settled pass is on an
  ANCESTOR of the tip is re-judged on the tip, in declared order, before the
  pipeline is `accepted`:
  - an **agent-review gate always re-judges** — as a fix-cycle review under
    the stateful protocol (WORKERS.md §10.4): its prompt carries the prior
    findings by ledger id and the commits between the candidate it passed and
    the tip, so it is asked "does the tree that changed under you still
    pass", not to review from scratch. There is no knob (E13). This is what
    keeps the review INDEPENDENT of every later fixer: a command gate's fix
    cycle, a rescue, or an integration fix cycle cannot alter what is accepted
    without the review seeing the alteration;
  - a **command gate re-judges by default** (`rejudge_on_repin`, §2.1) — a
    suite run on the tip from the trusted ref; `false` is the logged opt-out;
  - a re-judge that FAILS enters that gate's own fix cycle (its own `cycles`
    cap, its own ledger), which re-pins, which stales later gates again — the
    loop terminates because every re-pin is paid for by a bounded cap (§5.4);
  - a `rejudge_on_repin: false` command gate is the ONE way an accepted tip
    carries a verdict on an ancestor, and the `art-gate-*` fact says so
    (`candidate_id` ≠ the tip's), so a reader can tell.
  The shipped "only the failed gate re-runs" rule (WORKERS.md §10.4) is
  unchanged INSIDE a fix cycle; the re-judge is a separate step at the
  acceptance check, not a from-gate-0 restart. A rescue pass re-runs the
  whole list on the rescue's candidate, as today.
- **Integration always judges the tip**: the candidate worktree is
  `merge(target_ref, tip)` and the full suite runs there, so a factory that
  declares integration never lands a tree its suite did not run on.
- **The completion boundary names the tip**: the `art-merge-*` fact and the
  completion record (§4.3) carry the tip's `candidate_id`, `commit` and `tree`,
  and the chain of `supersedes` back to the first submission. A person reading
  the item later can tell exactly which tree was accepted and which trees the
  earlier facts were about.

A re-pin never touches `impl_state` (the stage settled at the first `candidate`)
and never restarts the gate list — the resume rule "a resumed pipeline re-runs
from gate 0 with each gate's memory intact" (WORKERS.md §10.8) is about a
DEAD worker, not a moved HEAD, and is unchanged.

### 3.4 The reference: portable means fetchable by locator

`reference` is what a controller that does not share this process's
filesystem needs in order to obtain `commit` and prove it resolves to `tree`.
**Portable** means exactly: self-describing, content-verified (`commit` and
`tree` are checked after the fetch, below), and obtainable by any reader that
can reach the store the locator names — never dependent on the producing
process, its working tree, or its machine being alive. Two shapes, both
portable by construction; a machine-local path is never one of them (it is
`provenance.cwd`, §3.1):

| `kind` | fields | reachable by | how a reader obtains the commit |
|---|---|---|---|
| `bundle` | `store: <bundle_store>` (the URI prefix, `file://` or `https://`), `key: <candidate_id>.bundle` (the object key inside the store), `locator: <store>/<key>` (the ONE absolute URI a reader fetches), `commit`, `sha256`, `bytes` | anyone who can `GET` the locator — the default `file://<SPOR_HOME>/candidates` reaches this machine and any mount of it; a declared shared-filesystem or `https://` store reaches further (§2.1) | fetch the bytes, check `sha256`, `git bundle verify`, `git fetch <bundle> <commit>` |
| `branch` | `locator: <fetch URL>` (the resolved URL of `candidate.remote`, never its name), `ref: refs/spor/candidates/<candidate_id>`, `commit` | anyone with read access to the URL | `git fetch <locator> <ref>` |

Under `publish: both` the candidate carries `reference` (the bundle) and
`references[]` (both), so a reader picks the door it can reach. A `bundle`
is `git bundle create` of `base.merge_base..commit`, so the reader needs
`base.merge_base` present, which the trusted ref's history guarantees.

**Reconciled (D3):** as above (§2.1), the `bundle` row's default locator is
`file://<userConfigHome>/candidates` in both modes, not
`file://<SPOR_HOME>/candidates` — everything else in the row (content
verification, the shared-filesystem/`https://` escape) is unchanged.

**What is refused as a reference** (checked at submission by the producer,
and again by every reader before a fetch): a locator that is not an absolute
URI with scheme `file` or `https`; a `file://` locator that does not resolve
under the declared or default `bundle_store` — in particular one under
`provenance.cwd`, under any run's `record.cwd`, or inside a `.git` directory
(a working tree and a repository's object store are not stores: they are
alive only while the process that made them is); a remote NAME where a URL
is required; a bare sha; a relative path. None of these is ever stamped as
`reference` — the submission is treated as a failed publish (I3a) with the
reason named, since the producer can publish correctly from the workspace on
the retry. **Reconciled (D4):** a reference whose SHAPE is refused is
classified `unpublishable` (`referenceRefusal` in lib/kernel/candidate.js,
`publishCandidate` in lib/shell/candidate-publish.js), and it spends NEITHER
pool (`PUBLISH_OUTCOME_POOLS`, lib/kernel/gates.js). A retry from the same
workspace against the same declared store produces the same shape, so
charging `retry` for it only drained the pool before the inevitable
escalation
(issue-spor-unpublishable-reference-shape-classified-infrastructure-until-pool-drains).
The two shapes that are knowable without a run's cwd are refused at worker
startup (`resolveBundleStore`). Only a genuine outage (an unreachable store,
a failed write or fetch) is `infrastructure` and takes the I3a retry.
`publish-conflict` and `candidate-mismatch` spend neither pool either. A
`branch` locator may also be `ssh://`: an scp-style remote
(`git@host:org/repo.git`) is normalized to its canonical `ssh://` form before
it is stamped. The `file`/`https`-only rule applies to the bundle STORE. The
portability property this buys is testable and tested (§6.6
test 6): a SECOND graph home, pointed at the same store, obtains and verifies
the candidate from the reference alone after the producer's worktree has
been deleted.

**The published object is immutable and keyed by `candidate_id`, and that is
consistent with §3.2 because the pinned commit never changes.** The ref
`refs/spor/candidates/<candidate_id>` and the file `<candidate_id>.bundle`
each hold exactly the pinned commit; a re-pin is a NEW candidate (new id, new
object); a same-tree re-submission publishes nothing (its commit goes to
`commits_seen`). The publish itself is a real compare-and-swap, not a hope:

- `bundle`: the bundle is written to a temp path and moved into place with an
  EXCLUSIVE create (`COPYFILE_EXCL` / `wx` under `file://`; the hosted door is
  a `PUT` that the server refuses with `409` when the id exists, §7.5). If
  the object already exists, its `sha256` is compared with ours: equal is a
  no-op (a crash after a landed publish, replayed), different is
  `publish-conflict` — refused and escalated exactly like `candidate-mismatch`
  (§4.2 M1), because two different objects under one content-addressed id is
  corruption, not a race to win;
- `branch`: `git push <url> <commit>:refs/spor/candidates/<id>
  --force-with-lease=refs/spor/candidates/<id>:` (the empty expectation:
  "create only if absent"), never `--force`. A rejected push is followed by a
  `git ls-remote` of the ref: equal to our commit is a no-op, different is
  `publish-conflict`.

**Verification is mandatory and mechanical**, whatever the kind and whoever
the reader: after the fetch, `git rev-parse <commit>^{tree}` MUST equal
`tree`, and `commit` MUST equal `reference.commit`. The PRODUCER verifies its
own publish the same way (a fetch from the locator into a scratch repo, not a
read of its working tree — `reference.verified_at` is stamped only by that
round trip), so a bundle that was written truncated or a ref that landed on
the wrong commit is caught at submission, on the machine that can still fix
it. A mismatch is not a code failure and not an infrastructure failure — it
is a candidate whose evidence does not describe it, refused as
`candidate-mismatch`, consuming no pool, and escalated to a person with both
shas named (§4.2 rows M1-M2). A fetch that FAILS (unreachable locator, an
expired credential) is `infrastructure` (§5.3).

**Submission is not complete until the reference verified.** `publish` runs
at submission (the implementation run's terminal) and again at every re-pin,
and the candidate is `impl_state: candidate` only once `reference.verified_at`
is set. A publish that fails leaves the run in `implementing` (or the fix
cycle in `gating`) with `publish_pending` owed (§6.5), classified
`infrastructure` (§5.3), and RE-ATTEMPTED FROM THE WORKSPACE under the retry
pool — a publish retry re-runs `git bundle create`/`git push` on the commit
that already exists; it never re-dispatches the implementer. When the retry
pool is spent, the stage escalates (I8) with the commit, tree and the failing
locator named. There is no "proceed on the local path" — a candidate that no
reader could obtain is not a candidate, in either mode.

### 3.5 Other fields

- **`tree` is carried beside `commit`** because it is the identity (§3.2); the
  commit is carried because it is what git fetches and what a person cites.
- **`clean`** is the `require_clean` verdict at submission, computed with the
  same `git status` read the command gate uses (an unreadable status is `false`,
  never `true` — a refusal, per §10.3).
- **`resolver.resolves_edge: false`** is the whole point under
  `completion.by: controller`: the implementer wrote its resolver node, and the
  edge that retires the item is not on it yet. `true` here at submission means a
  premature resolution, handled in §4.5.
  **Reconciled (D1):** the implementer's resolver never carries the retiring
  edge, not even at completion. It links the item with `relates-to`, and the
  implementer names it in a fixed-form first report line, `CANDIDATE:
  <resolver node id> — <why>` (`parseCandidateReport`, lib/kernel/completion.js).
  A missing or malformed line is not a refusal; it only leaves the
  implementer's account unlinked. The `resolves` edge lives on a
  CONTROLLER-written completion record (§4.3 step 1), so `resolver` here is
  provenance only.

---

## 4. Lifecycle

### 4.1 States

The stage state lives on the run record as `impl_state`, mirroring `gate_state`
(WORKERS.md §8) — the same durable-resume shape, the same "settled is final"
rule, and deliberately the same failure posture: an unrecognized value RESUMES
rather than being read as a verdict.

- `impl_state` settled: `candidate`, `declined`, `exhausted`, `escalated`,
  `unroutable`, `mismatch`
- `impl_state` unsettled (resumable): `dispatched`, `running`, `interrupted`
- per-ATTEMPT outcome (recorded on `impl_attempts[]`, never a stage state):
  `pending` (launched, not yet classified — charges nothing), then exactly one
  of `candidate`, `no-candidate`, `failed`, `infrastructure`, `cancelled`,
  `declined`, `candidate-mismatch`; the entry's `pool` is written in the SAME
  stamp as the outcome (`null` while `pending`), so a pool is charged exactly
  once per attempt entry, at classification, never at launch (§5.3). A
  candidate's PUBLISH retries are not implementation attempts: each is its own
  entry in `impl_candidate.publish_attempts[]` (`{index, started_at, outcome,
  pool: "retry"}`), so the run record that produced a committed, clean tree
  charges `budget.attempts` exactly once for the code and `retry` once per
  publish retry — never the code pool twice, never the retry pool for the code

`no-candidate` and `cancelled` are attempt outcomes, not terminal stage states:
each consumes an attempt from the code pool and either re-dispatches or
exhausts the stage (§4.2 rows I3-I11). The distinction matters because an
earlier draft listed them as settled states AND said they consumed attempts,
which left "what happens after the pool is spent" unwritten.

**Reconciled (D2), what `pending` means.** `pending` is a RESERVATION, not a
reading of an outcome. It is the state of an entry whose run has not ended,
or whose terminal observation this pass could not make (the record is
unreadable, or the stamp that would settle it did not land). It is never the
verdict on a run that DID end. A terminal run is always classified by
`classifyExecutionOutcome`, and that result is authoritative: a terminal
reading the classifier does not recognize (an unknown `termination_signal`,
an unreadable transcript, a word a newer client wrote) is `failed` on the
code pool, the bounded side (§5.3 rule 1). It does not stay `pending`, because
an unrecognized terminal left pending would never charge a pool and would
never settle the stage
(issue-spor-implementation-design-unknown-terminal-outcome).
`implAttemptDecision` applies the same rule one level up: an attempt outcome
it does not know settles `exhausted`, never `retry`. What RESUMES on an
unrecognized word is the STAGE state (`impl_state`, `implResumable` in
lib/kernel/candidate.js). A stage verdict nobody gave must not be invented,
and that is a different field from an attempt's outcome. The shipped attempt
vocabulary (`IMPL_ATTEMPT_OUTCOMES`) also carries `unpublishable` and
`publish-conflict` beside the words above (D4).

Pipeline states, in order: `claimed → held → implementing → candidate →
gating → accepted → integrating → landed|parked → completed`, with
`exhausted`, `escalated`, `unroutable`, `mismatch`, `refused` and `abandoned`
as the off-ramps. Under `completion.after: gates` with integration declared
the order is `accepted → completed → integrating → landed|parked` (§4.2 rows
C1-C4). `held` is the execution HOLD on the item (§4.5): from H1 until the
completion write (or a withdraw/consume) clears it, no resolving edge into the
item retires it, whoever wrote the edge.

### 4.2 Transition table

`consumes` names the budget pool spent (§5.3). "graph write" is exhaustive —
anything not listed writes nothing. Row ids are referenced from the tests in
§6.6.

**A refusal is not an attempt.** The rule that keeps the table consistent:
anything refused BEFORE a run record exists (satisfiability, a launcher that
does not resolve, a claim the server refused, an item out of `repos` scope)
is a refusal — it cools the item and spends nothing; anything that happens
AFTER a run record exists is classified from that record (§5.3) and spends the
pool its class names.

| id | from | event | guard | to | graph write | consumes |
|---|---|---|---|---|---|---|
| H1 | claimed | the execution hold is stamped on the ITEM (`execution: <execution_id>`, a CAS `put_node` with the claim's revision; local mode: the blob-sha compare of §4.3) | `completion.by: controller`; the item carries no live resolving edge (a non-empty `impl_claim.resolving_snapshot` means it is not gateable and `shouldGate` never starts); the item carries no `execution:` of a DIFFERENT execution — a foreign hold whose worker is live is refused as H2 (two executions never hold one item), a foreign hold that reads stale (§4.5) is taken over only through the explicit doors (`--regate`, `spor release --execution`) and never by a fresh claim, and a hold naming OUR execution (a same-factory resume) is re-stamped idempotently | held | `execution:` + `execution_at:` on the item — the only item write before completion apart from P1's status restore | — |
| H2 | claimed | the hold stamp fails (a `409` from a moved revision, a transport error, an unwritable node file) | — | **unroutable** (cooled; the lease released; stderr names it) — **no hold, no launch** | — | none |
| I1 | held | stage dispatch launched (a run record exists, CREATED with `impl_claim` and `impl_attempts[n] = {outcome: "pending", pool: null}` — one write, §6.5) | profile satisfiable; item in `repos` scope | implementing | — (the claim/lease already exists) | **nothing** — the attempt is RESERVED, charged at classification |
| I2 | held | dispatch refused before any run record (satisfiability; a launcher that does not resolve — ENOENT, a broken `dispatch.bin.<h>`; a refused claim) | — | **unroutable** (cooled for `work.retryAfterMs`, stderr names the cause; the hold is cleared by the same CAS door, §4.5) | — | none |
| I3 | implementing | run terminal; a commit past `merge_base`; tree clean (the attempt entry settles `{outcome: candidate, pool: implementation}` HERE, on the code outcome, before any publish); `reference` published AND verified (§3.4) | `require_clean` | **candidate** | implementer's resolver node, **no `resolves` edge** | `budget.attempts` (the attempt was used; §7.1's `pools.implementation.spent`) — once, whatever the publish then costs |
| I3a | implementing | run terminal; a commit past `merge_base`; tree clean (the attempt entry is ALREADY settled `{candidate, implementation}` as in I3); publish FAILED (§3.4) | `retry.attempts` left | implementing, `publish_pending` owed — the publish is re-attempted from the workspace after `retry.backoff_ms` as a NEW `publish_attempts[]` entry; the implementer is NOT re-dispatched and no `impl_attempts[]` entry is added | — | `retry.attempts` — one per publish retry, charged on the publish entry; the code pool was charged once at the settle and is never charged again for this record (F15) |
| I4 | implementing | run terminal; a commit past `merge_base`; tree DIRTY under `require_clean` | attempts left | implementing (the dirty-tree round-trip, §10.3, re-dispatched at the same run) | — | `budget.attempts` |
| I5 | implementing | run terminal; no commit past `merge_base` (`no-candidate`) | attempts left | implementing | report artifact (WORKERS.md §7) | `budget.attempts` |
| I6 | implementing | run reports `DECLINED:` | — | declined | decline finding (existing) | none — triage, never a retry (§10.2) |
| I7 | implementing | outcome classified `infrastructure` (§5.3) | `retry.attempts` left | implementing (after `retry.backoff_ms`) | — | `retry.attempts` |
| I8 | implementing | outcome classified `infrastructure` | retry pool spent | **escalated** | escalation item `blocks` the work item | — |
| I9 | implementing | outcome classified `failed` (code) | attempts left | implementing | — | `budget.attempts` |
| I10 | implementing | idle/watchdog ceiling hit (`cancelled`) | attempts left | implementing | — | `budget.attempts` |
| I11 | implementing | `failed`, `no-candidate`, `cancelled`, or dirty-under-`require_clean` | **code pool spent** | **exhausted** | escalation item `blocks` the work item; the last attempt's report artifact | — |
| I12 | implementing | worker stopped mid-run | — | interrupted (resumed by name, §5.1); a `pending` attempt on resume is classified from its record like any other (§5.3), so the reservation is charged exactly once | — | — |
| P1 | implementing / gating (poll) | the item carries an inbound resolving edge not in the claim snapshot | `completion.by: controller` | unchanged, debt `retract` (§4.5) — the edge is already INERT under the hold (§4.5), so this is evidence repair, not release prevention | the edge retyped `resolves` → `relates-to` on its source node; the item's status restored | — |
| M1 | candidate / gating / integrating | a reader's fetch of the tip reference (a resumed worker, a hosted controller, the re-judge at G9, the integration candidate build) finds `rev-parse <commit>^{tree}` ≠ `tree`, or `commit` ≠ `reference.commit` | — | **mismatch** (terminal, `impl_state: mismatch`; the attempt's outcome `candidate-mismatch`) | escalation item (`requires: [human]`) `blocks` the work item, naming `candidate_id`, both trees and the locator; the item's status is untouched (it was never flipped); the hold STAYS (fail-closed: a person or `spor work --regate` settles it) | none — neither pool; the evidence is wrong, not the code and not the wire |
| M2 | implementing (submission) | the producer's own post-publish verification (§3.4) fails, or the publish finds a different object under the id (`publish-conflict`) | — | **mismatch** (as M1) | as M1 | none |
| G1 | candidate | gate list starts | — | gating | — | — |
| G2 | gating | a gate passes | — | gating | `art-gate-*` fact (`candidate_id` = the candidate it judged) | — |
| G3 | gating | a gate fails | `cycles` left | gating (fix cycle → **re-pin**, §3.3) | `art-gate-*` fact | gate `cycles` |
| G4 | gating | a gate fails | cycles spent, `rescue:` declared | gating (rescue pass → re-pin) | `art-gate-*` + `art-rescue-*` | `rescue.attempts` |
| G5 | gating | a gate fails | nothing left | **refused** | escalation item `blocks` the work item | — |
| G6 | gating | a gate dispatch (review, fix, rescue) classifies `infrastructure` | `retry.attempts` left | gating (the same dispatch re-made after backoff; the gate's cycle NOT charged) | — | `retry.attempts` |
| G7 | gating | a gate dispatch classifies `infrastructure` | retry pool spent | **refused** (`escalation` names the outage, not the code) | escalation item `blocks` the work item | — |
| G8 | gating | a human gate armed | — | gating (awaiting) | approval item `blocks` the work item | — |
| G9 | gating | every gate settled `passed`/`skipped`, and every gate whose pass is on an ancestor of the tip has been RE-JUDGED on the tip (§3.3: every agent-review gate, every command gate not opted out) | — | accepted | `art-gate-*` fact per re-judge (`candidate_id` = the tip) | — (a command re-judge is a suite run; a review re-judge is a dispatch counted in §5.4) |
| G10 | gating | a re-judge at G9 fails | that gate's `cycles` left | gating (that gate's own fix cycle → re-pin → the re-judge set is recomputed) | `art-gate-*` fact | that gate's `cycles` |
| G11 | gating | a re-judge at G9 fails | that gate's cycles spent | G4 (rescue) or G5 (refused), as for any gate failure | as G4/G5 | as G4/G5 |
| C1 | accepted | `completion.after: gates` | — | **completed** (§4.3) | `resolves` edge, then ONE CAS `put_node` writing the terminal status AND clearing the hold; debt `write` → consumed | — |
| C2 | completed | `integration:` declared (only reachable under `after: gates`) | — | integrating | — | — |
| C3 | integrating (post-completion) | conflict / candidate suite fails | `integration.cycles` left | integrating (fix cycle → re-pin → every agent-review gate re-judges the new tip (§3.3) before the candidate build is retried; the item STAYS completed — the edge was written by declaration, and the completion record names the candidate it completed) | `art-gate-*` per re-judge | `integration.cycles` (+ the review's `cycles` if its re-judge fails) |
| C4 | integrating (post-completion) | conflict / candidate suite fails | spent | **landed-refused** (terminal; the item STAYS completed) | `requires: [human]` item `relates-to` the work item and names the tip candidate — never `blocks` (a completed item has nothing to block) and never a demotion (the edge was written by declaration) | — |
| N1 | accepted | `integration:` declared, `after: integration` | — | integrating | — | — |
| N2 | integrating | CAS land succeeds | — | landed | `art-merge-*` fact (tip `candidate_id`) | — |
| N3 | integrating | PR opened (`mode: propose`) | — | parked | `art-merge-*` + tracking item | — |
| N4 | integrating | conflict / candidate suite fails | `integration.cycles` left | integrating (fix cycle → **re-pin** → every agent-review gate, and every non-opted-out command gate, re-judges the new tip (§3.3) before the candidate build is retried) | `art-gate-*` per re-judge | `integration.cycles` (+ that gate's `cycles` if a re-judge fails) |
| N5 | integrating | conflict / candidate suite fails | spent | refused | escalation `blocks` the work item | — |
| N6 | integrating | lost CAS race | `RACE_RETRY_CAP` left | integrating (rebuild against the new tip; the candidate is unchanged — the merge commit is not the branch) | — | none |
| N7 | landed | `completion.after: integration` | — | **completed** | `resolves` edge, then ONE CAS `put_node` writing the terminal status AND clearing the hold; debt `write` → consumed | — |
| N8 | parked | PR merges (a later `checkProposals` pass) | — | **completed** | landed `art-merge-*`, tracker resolved, then `resolves` edge + the status/hold-clear CAS | — |
| N9 | parked | PR closed unmerged | — | refused | recorded on the tracker; left for a person (§10.9) | — |
| T1 | refused / escalated / exhausted / unroutable / mismatch / landed-refused | — | — | terminal | nothing further. The hold on a refused/escalated/exhausted/mismatch item STAYS until the door back — `spor work --regate` (resumes under the same hold), a re-claim by a same-factory worker (H1 re-stamps it), or a person's explicit `spor release --execution <id>` / `set_status abandoned` (§4.5). `unroutable` and `landed-refused` clear it (nothing is judging the item) | — |

**Reconciled rows (D6, D8, D9).** The stage runner shipped these rows with
the refinements below (lib/shell/implementation-stage.js; WORKERS.md §10.16).
Each is the canonical reading.

- **I2 on a re-dispatch.** A later attempt that the box refuses before any
  run record exists withdraws its ledger reservation (a refusal is not an
  attempt). Nothing is escalated, the stage reports `unroutable`, and the
  caller clears the hold (T1).
- **I10, split.** The idle stop (`termination_class: idle`) is `cancelled` on
  the code pool and re-dispatches while attempts are left, as written. A
  re-dispatched attempt this box could not FOLLOW to its end (the launcher's
  deadline, or a watchdog that gave up on it) is also settled `cancelled`. But
  the stage then ESCALATES (`escalated`) instead of re-dispatching, because
  something may still hold the checkout.
- **A ledger stamp that does not land escalates.** Under §6.5 (a) the entry
  would stay `pending` for a later pass. On a live worker there is no later
  pass for this slot, so the stage stops `escalated` rather than act on a
  charge nobody recorded. The gate runner applies the same rule to a pool
  charge that could not land.
- **An empty segment with no stop requested escalates too**
  (task-spor-work-loop-parked-reoffer-cap, landed after this reconciliation's
  ad94f9d baseline — §11.5). I12's `interrupted` is reserved for a STOP; a
  segment with no attempt at all and no stop asked for no longer resumes as a
  re-offerable `interrupted` (re-offering the pipeline would find the same
  empty ledger every time). The stage settles `escalated` through the same
  `stop()` door, riding the reason on the record itself
  (`impl_stop_reason`) since there is no entry to carry it, so a resumed
  settled stage re-files the byte-identical escalation.
- **Retry order.** On the retry pool the order is: charge the pool, then
  RESERVE the next attempt, then wait out `retry.backoff_ms`. A worker stopped
  during the wait therefore leaves a pending reservation that the resume
  launches.
- **H2 after the store opened.** When the execution store (§7, WORKERS.md
  §10.15) opened an execution and the hold stamp is then refused, the
  execution is ENDED, so neither the item pointer nor the server's write gate
  keeps holding an item that nothing will run under.
- **M1 at integration.** An integration-stage mismatch (the branch no longer
  carries the pinned candidate) is recorded on `integration_state: mismatch`,
  on `gate_state` and on the escalation, not on `impl_state`.
  `impl_state: mismatch` is reached only through the stage's own decision
  (`implAttemptDecision` on `candidate-mismatch`).
- **Pipeline attempts.** `spor work --regate` opens a NEW segment of the
  `impl_attempts[]` ledger (`implAttemptKey`), with a fresh code pool beside
  the fresh infrastructure pool. The re-dispatch names key one segment deeper
  (`impl-<short>-r2-<n>`). An earlier segment that still owes a launched
  attempt its classification is adopted under its original key instead.

### 4.3 The completion write: forced order, and a real compare-and-swap

Under `completion.by: controller` the item never carried a LIVE resolving
edge: from H1 it holds `execution: <id>`, and under that hold `resolutionMap`
counts no inbound `resolves`/`answers` into it (§4.5). So there is nothing to
roll back and §10.7's demotion is not needed on this path (it stays in the
code for `by: agent` factories). Completion is two writes in ONE forced
order, and the second is the compare-and-swap that both retires the item and
releases the hold — one write, so there is no state in which the item is
retired-but-held or released-but-not-retired:

0. **Re-read the item** (`get_node`, which returns its `revision`) and
   reconcile against settled state (§6.5 row (d)) — an item whose hold is
   already cleared and that is `done`, `abandoned`, or resolved by a different
   candidate ends the write here with the debt consumed or withdrawn. An
   item that still carries OUR hold is, by construction, not resolved by
   anyone: whatever resolving edges were added onto it since the claim are
   inert, and P1 retypes them as evidence.
1. **`add_edge` `resolves`** from the candidate's resolver node to the work
   item. The edge lives on the RESOLVER, a node this pipeline created and owns
   (content-addressed to the candidate), so this write contends with nobody.
   Idempotent: an existing identical edge is `skipped`. Under the hold this
   edge is still inert — nothing is released by step 1.
   **Reconciled (D1):** as shipped, the resolver is a new `artifact` that the
   CONTROLLER writes: `art-completion-<stem>-<first 12 hex of the candidate>`
   (`completionResolverId`/`buildCompletionResolver`, lib/kernel/completion.js).
   It is content-addressed to the candidate and carries the `resolves` edge in
   its own validated write. It also carries `relates-to` edges to every
   gate/merge fact and to the implementer's resolver. It is byte-stable for
   the same inputs, so a re-driven write is idempotent. Before this step, the
   execution store's `confirm` (flush the event outbox, then renew under the
   fence) must answer `ok`. Otherwise the completion stays owed
   (WORKERS.md §10.15, D10).
2. **`put_node` the ITEM with the terminal status, `execution:` REMOVED, and
   the `revision` from step 0.** This is the compare-and-swap: API.md §1
   rejects a stale revision (`409`) rather than last-write-wins, and the
   moment it lands the hold is gone, our edge counts, and dependents are
   released — the completion boundary is this one write. The body is the
   node as step 0 read it at that revision, so the hold it removes is
   necessarily the hold step 0 saw — and step 0 refuses to proceed at all
   unless that hold names OUR execution (a different one is the branch
   below). `set_status` is
   deliberately NOT used here — it is a server-side read-modify-write with no
   revision echo, which is exactly the check-then-write window the write must
   close.

The order is not a preference: the seed schema's completion gate
(task-cc-terminal-status-requires-resolver) REFUSES a terminal status that has
no resolver, so status-first cannot land.

**Why the hold, and not the revision, closes the race** (the finding that
survived two drafts): the item's `revision` moves only when the ITEM's file
changes, and a resolving edge is written on the SOURCE node — so a person or
another execution that adds a resolving edge from a different resolver between
step 0 and step 2 leaves the revision identical and the CAS blind to it.
Under the hold that write is inert: the item is retired by nothing until step
2 clears the hold, and step 2 is ours (the hold names our execution, and the
only other writer of `execution:` is a person's explicit release, which moves
the revision and is a `409`). The foreign edge is then a premature resolver by
the P1 rule — source not in the claim snapshot — and is retyped. A person's
STATUS write (the other half of "resolve or abandon under us") DOES move the
revision and is caught by the CAS. Both halves of the race are therefore
observed: the status half by the revision, the edge half by the hold.

**On a `409` at step 2**, re-read and branch on what moved:

- the item is now `abandoned` (a person dropped the work under us): our edge
  is WITHDRAWN — retyped `resolves` → `relates-to` on our own resolver via
  `remove_edge` + `add_edge` (or one `put_node` of the resolver with its
  revision) — and the hold is cleared with a CAS `put_node` on the fresh
  revision that touches nothing else (an abandoned item has no execution to
  hold it). The debt settles as `withdrawn`. A gate never reverses a person's
  decision to drop work, and an abandoned item must not be retired by our
  edge as if it were finished;
- the item is `done` and our hold is GONE (a person explicitly released the
  execution and then resolved it with their own resolver): consumed, nothing
  more written — a second resolving edge on a finished item is harmless
  provenance, and the status is already what we wanted;
- the item is `done` and our hold is STILL PRESENT (a person flipped the
  status by `set_status` past the seed gate on the strength of a resolver
  edge that is inert under the hold): the person's terminal status is a
  decision this pipeline does not reverse — the CAS is retried on the fresh
  revision writing ONLY the hold-clear, which makes their resolver (and ours,
  if step 1 landed) count. Consumed;
- the item now carries a DIFFERENT execution's hold (a person released ours
  with `spor release --execution` and a later claim stamped a new one, or a
  `--regate` re-entered the item under a fresh execution id): the item is no
  longer ours to complete. Our edge is WITHDRAWN as in the `abandoned` branch
  and nothing on the item is written — the other execution's own completion
  write decides, and its P1 rule reads our resolver as premature by its own
  snapshot. The debt settles as `withdrawn`;
- the item is still open and only a non-terminal field moved (a priority or
  readiness stamp bumps the revision): retry the CAS with the fresh revision,
  bounded at 3, then leave the debt owed for the next pass.

**Local mode** has the same shape with a different CAS: `setStatusLocal`'s
read-modify-write is replaced for this path by a write that compares the
node file's blob sha (`gitBlobSha`, already in bin/spor.js) read at step 0
against the sha at write time, under the machine-local lease integration
already takes for its own serialization (`acquireLocalIntegrationLease`) so
the only other writer on the box — a second worker — is serialized, and a
person's hand edit is caught by the sha compare. The write itself is
temp-file-plus-rename, as every node write in the graph home is.

**Hosted mode** does the whole of steps 0-2 server-side under the execution's
fence (§7.5), which is the atomic form this client can only approximate.

**Dependents.** Everything downstream of the work item — `blocks` edges, the
program view, the ranker's blocked-demotion — is derived from
`resolutionMap`, and under the hold that map has no entry for the item. So a
pipeline that is still implementing, still gating, refused, or dead releases
nothing, whatever edges anyone wrote in the meantime. That is criterion 2's
"failed/pending gates must not release dependents", achieved by the hold from
H1 to step 2 — not by the absence of an edge, which this client cannot
guarantee (§4.5).

### 4.4 What a refused pipeline leaves

The item keeps its `open` status (it was never flipped), carries no resolving
edge, and is `blocks`-ed by the escalation the gate filed — the fail-closed half
of §10.7, unchanged. It is cooled off on this box for `work.retryAfterMs` and
demoted in the ranker by the live `blocks` edge, so it does not come straight
back round to a worker. The tip candidate's commit is still in the run's
checkout and named on the escalation with its `candidate_id`, `tree` and
reference; a person (or a `spor work --regate <run-id>`) is the door back.

### 4.5 Premature resolution: inert under the hold, retyped as evidence, refused where a server exists

Under `completion.by: controller`, an implementer that writes a `resolves`
edge anyway has broken the contract. Two earlier drafts answered that with
detection plus repair — a status rollback, then a retype — and both left the
same hole the review's queue probe reproduced: because liveness is
edge-derived, the edge released the item's dependents the moment it was
written, and nothing this client does AFTER a write can un-release them for
the window before it noticed. Local mode has no write interposition. What it
does have is the read side, and the read side is ONE function.

**The execution hold.** At H1 — before any dispatch — the controller stamps
the item with `execution: <execution_id>` (and `execution_at:`), a flat
frontmatter key like every other stamp on a node, written with the same
CAS door as completion (§4.3: `put_node` + `revision` remotely; the blob-sha
compare under the machine-local lease locally). And `resolutionMap`
(`lib/kernel/resolution.js`, the sole derivation every read surface and the
server consume — preamble fact 4) gains one rule:

```
// lib/kernel/resolution.js — ONE exported predicate, read by BOTH halves
executionHeld(node) = typeof node.execution === "string" && node.execution !== ""

// the EDGE half — resolutionMap
for each resolver r, each edge e of type resolves|answers, target t = graph.nodes[e.to]:
  if (executionHeld(t))       // an OPEN execution hold on the target
    continue;                 // no inbound resolving edge retires a held item
  …existing rule unchanged…

// the STATUS half — queue.isLive, the node-level predicate every `blocks`
// traversal, liveBlockers, deriveReadiness, rankQueue and program.js go through
isLive(node, supersededBy, graph):
  if (supersededBy[node.id]) return false;
  if (executionHeld(node))                  // a held item is live whatever COMPLETION status it carries,
    return !isGiveUpStatus(node.status, node.type, graph);   // but a give-up status (abandoned) is dead
  return !isTerminalStatus(node.status, node.type, graph);
```

**Reconciled (D5):** the draft read a held item as live under ANY status. The
shipped `queue.isLive` (lib/kernel/queue.js) excepts a GIVE-UP status
(`resolution.isGiveUpStatus`: non-resolving for the item's own type AND inert
for it, e.g. task `abandoned`). The hold keeps a *completion* inert. It does
not keep a person's decision to drop the work inert: the person's door
(`set_status abandoned`, below) takes effect on the status half at once. The
reconciler then withdraws a hold that outlived the abandonment
(`deriveCompletionDebt` owes `withdraw` when our hold OR our edge stands on a
given-up item). Remote completion reads the live `/v1/schema` partitions and
refuses to mutate when it cannot verify them (WORKERS.md §10.13).

That is the whole change, and it is enough — and it must be BOTH halves,
because an implementer that breaks the contract has two doors, not one: the
`resolves` edge (the edge half), and `set_status done` / `spor set-status`
(the status half — the seed completion gate passes it today, because that
gate reads `view.resolvers`, where the inert edge is present). Under the hold
both are inert: from H1 until the completion CAS removes the key, the item is
retired by nothing — not the implementer's edge, not a person's, not a second
execution's, and not a terminal status written by any of them — on the queue
(`queue.js:541`/`:761`), in the program view (`program.js:23`), on `get_node`'s
resolution surface (`graph.js:1242`/`:1248` read `isTerminalStatus` directly
today and gain the same `executionHeld` short-circuit, reporting `held`
rather than `done`), in the ranker's blocked-demotion, and in `liveBlockers`.
Dependents stay blocked because their blocker is live on both halves. The
window that the previous draft admitted ("between the implementer's write and
the next poll, dependents ARE released") does not exist: the edge and the
status flip are inert from the instant they are written, on every reader
running this lib. The write side gets the same rule wherever a write door
exists, as hygiene on top of the read guarantee: the seed `schema-task`
`transitions()` gate REFUSES `done` on a node whose PROPOSED frontmatter
still carries `execution:` (the completion CAS passes, because its
`put_node` body removes the key in the same write; a bare `set_status done`
on a held item is refused at the door with a reason naming the execution),
and `setStatusLocal` gains the identical refusal for the local CLI. A direct
file write in local mode has no door, which is exactly why the read rule, not
the refusal, is the guarantee. The schema-task `get()` hook — the read-time twin the
held-guard already keeps in lockstep with the queue (`hasInboundOutcome`) —
gains a one-line "under execution `<id>` since `<at>`" note so a person
reading the item sees WHY its resolver does not count.

**Retyped, not deleted — as evidence.** The edge is still a contract
violation and still misleading provenance, so the controller retypes it
(`resolves` → `relates-to`) in both modes, unchanged from the previous draft:
remote `DELETE /v1/nodes/<resolver>/edges {type: "resolves", to: <item>}`
(API.md §3, `remove_edge`'s REST twin) then `POST …/edges {type:
"relates-to", …}`; local an in-place frontmatter rewrite of the resolver
file (`removeEdgeLine`, the twin of `appendEdgeLine`) followed by
`appendEdgeLine`, one temp-file-plus-rename. WORKERS.md §10.7's reason for
never retracting under `by: agent` — the resolver is the agent's own durable
record — is honored: the node stays, the link stays, only its type changes.
`premature_resolution: true` is recorded on the candidate and on the first
`art-gate-*` fact. If the pipeline later passes, §4.3 adds the `resolves`
edge back on the same resolver; if it refuses, the item is left open,
unresolved and blocked by the escalation (§4.4).
**Reconciled (D1):** a retyped edge is never restored to `resolves`. The
completion is carried by the controller's own `art-completion-…` record
(§4.3), which lists the retyped sources and sets `premature_resolution: true`.
The run record carries `completion_premature` as well. The retype is no longer
load-bearing for dependents — the hold is — which is what makes its timing
(below) a matter of evidence hygiene rather than of correctness.

**Which edges are premature.** At claim time the controller snapshots the
item's inbound resolving-edge sources (`impl_claim.resolving_snapshot`,
normally empty — a non-empty one means the item is not gateable and
`shouldGate` never starts; H1 is refused). Any inbound `resolves`/`answers`
edge whose source is not in the snapshot is premature, whoever wrote it: a
person's own resolver written mid-execution is retyped by that rule too, and
that is the correct reading — the item was under an open execution, and a
person who wants to end that execution has an explicit door (below).

**When.** At candidate submission (I3, before G1) and at every harvest poll
while the slot is `implementing` or `gating` (P1) — one `get_node` per held
slot per poll. A status flip is rolled back in the same pass to the value the
claim recorded (`impl_claim.status_snapshot`); like the retype it is
evidence repair, since the item is held by this pipeline's lease and out of
selection on this box.

**The person's door.** A held item can be taken out of the controller's hands
only explicitly: `spor release --execution <id>` (clears the key with the
CAS door and records `execution_released_by`), or `set_status abandoned`
(which §4.3's withdraw branch honors). Neither the implementer nor a
`resolves` write has that power, which is the point. A hold left by a dead
worker is FAIL-CLOSED: the item stays unretired (nothing is lost — it was
never done) until a same-factory worker resumes the pipeline (`orphanedGateRuns`
adopts by run name and H1 re-stamps the same execution id), `--regate`
re-enters it, or a person releases it; `spor work --status` and `spor get`
show a hold whose execution has no live worker as **stale**, never as done.

**Version skew, the residual.** The hold is a read rule, so a reader running
a lib OLDER than item 3 in §8 does not apply it and would count the premature
edge. That is the same class of skew any `resolutionMap` change has had (the
non-resolving-status partition, the answers-only-questions rule) and is
handled the same way: the rule ships in `lib/`, which the server, the CLI and
the hook engines share, so there is no deployment in which the controller
applies the hold and its own queue does not. Hosted mode adds the write-side
enforcement this client cannot provide (§7.5): the server REFUSES a
`resolves`/`answers` write into an item whose execution has not reached its
completion boundary — and applies the same read rule for readers that are
not this lib (the MCP view, the app).

The retraction is a durable debt (`completion_debt: "retract"`, §6.5) so a
crash between detection and the rewrite is re-driven, and it reconciles
against settled state before acting: an edge already gone, or an item that
became `abandoned` meanwhile, consumes the debt without writing.

---

## 5. Adapter mapping — no parallel runner

### 5.1 Start / observe / cancel / recover

Every one of these already exists. The stage names WHICH existing thing owns
each responsibility; it introduces no new process, no new supervisor and no new
launch path.

| responsibility | owner today | what the stage adds |
|---|---|---|
| **start** | `dispatchThrough` → `cmdDispatch` (`supervisedOnly: true`, `carryTask: true`), serialized on `DISPATCH_LOCK` | the resolved profile (§2.3), the stage prompt (§6.1), and a run NAME `impl-<node-short>-<attempt>` so a resumed worker adopts by name instead of dispatching twice (the convention `gate_fix_gate`/`shortRunAttempt` already uses). **Not** `--run-max`/`--run-idle`: `cmdDispatch` takes neither, and they are worker-global poll ceilings, not per-run flags. The budget rides the RUN RECORD instead (below). |
| **budget** | `pollWorkRuns` (bin/spor.js) passes the worker-global `maxAgeMs`/`idleMs` into `runHarvest` for every run it follows | the launch stamps `impl_budget: {run_max_ms, run_idle_ms}` on the run record (the same on-launch stamp path `gate_fix_run_id` uses), and `pollWorkRuns` resolves each record's ceilings as `record.impl_budget?.run_max_ms ?? maxAgeMs` (likewise idle) — one line in the `runHarvest` call. A record with no stamp (a legacy run, or a stamp write that failed) takes the worker-global ceiling, which is the shipped behavior and the safe direction. Gate dispatches (review, fix, rescue) keep the worker-global ceilings; the stage budget bounds the implementation run only. |
| **observe** | the run record + `pollWorkRuns`; `observedActivityAt` (log/transcript mtime) | nothing — the stage reads the same record. `impl_state`/`impl_attempts`/`impl_candidate` are stamped by the loop, never by the harness |
| **cancel** | the idle-stop path in `work-loop.js`: SIGTERM the supervisor's detached process GROUP, ticks-guarded against pid reuse, SIGKILL after a bounded grace | the per-record ceilings above are what trip it. The lease is still NOT released by a stop (the terminal contract owns that) |
| **recover** | `orphanedGateRuns` + `gate_state`, joined against stale worker status files | the same scan reads `impl_state`: an unsettled stage on a dead worker's slot is adopted by a worker armed with the SAME factory, and adopted BY RUN NAME so an in-flight implementation is joined rather than re-launched |
| **typed outcome** | `terminal_state` + `terminal_enforced` + `termination_class` | the classifier in §5.3, which maps those into the stage vocabulary |

The harness itself is reached exactly as today: a built-in adapter
(`claude-code`, `codex`, `opencode`, `copilot`) or a machine-local
`dispatch.harness.<id>` declaration normalized by
`normalizeHarnessDeclaration` and synthesized into a registry-shaped adapter by
`declaredAdapter` — supervised-jsonl, prompt on stdin, `identityMode:
env-token`, all five declaration keys fixed by v1 scope. **The stage adds no
"is this declared?" branch anywhere**, which is the same guarantee
task-spor-dispatch-declarative-custom-harness paid for, and the reason this
design needs no new runner: a factory that wants a bespoke implementer declares
`harness: <id>` on its profile and binds it on the machine.

### 5.2 Read-only and posture

An implementation dispatch is NOT read-only and carries the worker's unattended
posture (`--permission-mode`/`--sandbox`/`--approval-policy`), filtered per flag
through the resolved harness's own `validateOptions` and translated by MEANING
where a flag does not survive — the exact machinery the rescue lane already
uses (`postureMeaning`, issue-spor-rescue-posture-foreign-restrictive-flag-
becomes-bypass). Review gates stay read-only and cross-model, unchanged: **the
independence of the review is not this stage's to relax.**

### 5.3 Infrastructure vs code, and which pool each spends

One shared pure classifier — `classifyExecutionOutcome(record)` in
`lib/kernel/gates.js` — over a RUN RECORD. It is never handed a pre-record
refusal: those are refusals (§4.2 row I2), not outcomes. **A pool is charged
exactly once per attempt entry, at classification, and never at launch**: I1
reserves an `impl_attempts[]` entry with `outcome: "pending", pool: null`,
and the classifier's verdict is stamped as `{outcome, pool}` in ONE write
keyed on the entry's `run_id` — so an outcome that classifies
`infrastructure` charges `retry` and NOT `budget.attempts`, a `failed` charges
`budget.attempts` and NOT `retry`, and a resume that classifies the same
record twice charges nothing twice (the second stamp finds the entry
settled). A run record has exactly ONE `impl_attempts[]` entry; what can
happen to it more than once — a candidate publish that fails and is retried
— is recorded on `impl_candidate.publish_attempts[]`, one entry per publish
try, each settling `{outcome, pool: "retry"}` the same way, so a committed,
clean tree whose publish fails twice reads as `budget.attempts` spent 1 and
`retry` spent 2, never `budget.attempts` 3 (the F15 double charge under
another name). The pool caps are read against settled entries — `pool` set —
across BOTH arrays for `retry` and `impl_attempts[]` alone for
`budget.attempts`, never against the count of launches.

| observation (on the run record) | class | pool |
|---|---|---|
| `termination_class: "environment"` (credit/rate/auth exhaustion) | `infrastructure` | `implementation.retry` |
| `state: "failed_launch"`, `termination_signal: "launch-failed"` — a record was created and the harness process died at boot | `infrastructure` | `implementation.retry` |
| `termination_signal: "supervisor-gone"` | `infrastructure` | `implementation.retry` |
| the terminal contract could not reach the graph (`terminal_enforced: false` with a transport error) | `infrastructure` | `implementation.retry` |
| candidate publish or fetch failed at a reachable-in-principle locator (§3.4) — retried from the workspace, never by re-dispatching the implementer | `infrastructure` | `implementation.retry`, charged on the `publish_attempts[]` entry — the implementation attempt entry, already settled on the code outcome, is untouched |
| supervised child exited nonzero for no recognized environment reason (`termination_class: "failed"`) | `failed` | `implementation.budget.attempts` |
| terminal with no commit past the merge base | `no-candidate` | `implementation.budget.attempts` |
| terminal, committed, tree dirty under `require_clean` | `failed` (the dirty-tree round-trip) | `implementation.budget.attempts` |
| `termination_class: "idle"` / watchdog | `cancelled` | `implementation.budget.attempts` |
| report opens `DECLINED:` | `declined` | neither — triage, never a retry (§10.2) |
| fetched commit's tree ≠ candidate `tree`, or `commit` ≠ `reference.commit`, or a different object under the candidate's id (`publish-conflict`) | `candidate-mismatch` | neither — refused and escalated (§3.4, §4.2 M1-M2) |

And the refusals that never reach the classifier, listed here so the two
tables cannot disagree again: a launcher that does not resolve (ENOENT, a
broken `dispatch.bin.<h>`), a profile this box cannot satisfy, a claim the
server refused, an item outside `repos` scope. All are `unroutable` (§4.2 I2):
no run record, no attempt, no pool — the item cools off for
`work.retryAfterMs` and waits for a box (or a config) that can, exactly as a
satisfiability refusal does today. A missing launcher is a persistent
misconfiguration, and charging it to a bounded pool would only turn a loud
refusal into a quiet exhaustion.

**Reconciled (D6), the canonical classifier and the two pools.** The table
above is realized in TWO layers, and they must not be read as one vocabulary:

- `classifyExecutionOutcome(record, refusal)` (lib/kernel/gates.js) answers
  "did the DISPATCH run?". It returns `{outcome, pool, reason}` over
  `completed | failed | infrastructure | cancelled | declined | unroutable`.
  `declined` is read first, then the infrastructure readings
  (`termination_class: environment`, `state: failed_launch`,
  `termination_signal: supervisor-gone`, and `terminal_unreachable: true`
  without `terminal_enforced`). An idle stop is `cancelled`, and
  `termination_class: completed` is `completed`. Anything else is `failed`.
  `unroutable` is returned only when there is no record and the caller named
  a refusal. No record and no refusal is `failed`.
- `completed` settles nothing by itself. The stage then judges what the run
  PRODUCED (`judgeProduct`): `candidate`, `no-candidate`, or `failed` with the
  dirty flag. Four readings are HANDED to the pipeline's deterministic routes
  as a candidate instead: the stale-premise route, a `SCOPED:` claim, a dirty
  tree the factory tolerates, and a gone or unreadable checkout.
- A candidate's PUBLISH has its own classification, mapped to a pool by
  `PUBLISH_OUTCOME_POOLS`. `infrastructure` charges `retry`. `unpublishable`,
  `candidate-mismatch` and `publish-conflict` spend neither pool (D4). An
  unrecognized publish classification also spends neither pool.

The infrastructure pool is `gate_progress.pools.retry` on the pipeline's run
record. It is the SAME counter that the review/fix gates' `spendOutage` reads,
so it is one pool per PIPELINE ATTEMPT: a `--regate` opens a fresh one. A
factory that declares no `implementation:` block has a cap of 0 on BOTH pools
(`executionPoolCap`). Under such a factory nothing is retried on a budget
nobody declared, and an outage STOPS instead of being charged to the code as
a rejection.

Two rules bound the classifier:

- **Ambiguity classifies as `failed`, not `infrastructure`.** An infrastructure
  reading spends a pool that does not consume the item's attempts, so a
  misclassification there loops; the same misclassification in the other
  direction costs one attempt and stops. Fail toward the bounded side.
- **A gate's own dispatch (review, fix, rescue) uses the same classifier**, so an
  outage during a review is not `changes_requested` (§4.2 G6/G7): the same
  dispatch is re-made after `retry.backoff_ms` and the gate's cycle is not
  charged. Wiring that into the review gate is
  issue-spor-review-gate-reviewer-outage-read-as-rejection's task, listed in §8
  with an edge — this document defines the classifier and the pool, it does not
  silently re-scope that issue.

**The infrastructure pool is per PIPELINE, not per dispatch.** `retry.attempts`
is the total number of infrastructure re-dispatches the whole pipeline may
make — implementation, reviews, fixes and rescues together. That is what keeps
the bound below a sum and not a product.

### 5.4 Total dispatch bound per item per pipeline

What an operator is signing up for, counting DISPATCHES (agent launches; suite
runs are listed separately because they are what a command gate costs):

```
R  = #agent-review gates;   C  = #command gates not opted out of rejudge_on_repin
P  = Σ over command gates g of cycles_g                          — re-pins a command gate's fix cycles can cause
   + Σ over review gates g of cycles_g                           — re-pins a review's own fix cycles cause (its own re-review is counted below; OTHER reviews re-judge)
   + integration.cycles                                          — re-pins integration fix cycles cause
   (P counts the maximum number of times the tip can move after a gate passed; a re-judge that fails
    enters that gate's fix cycle, already inside these caps, so P is a fixed point, not a series)

dispatches ≤ budget.attempts                                     — implementation
           + Σ over agent-review gates g of (1 + 2·cycles_g)     — initial review, then per fix cycle one fix + one re-review
           + Σ over command gates g of cycles_g                  — one fix dispatch per fix cycle (the suite is not a dispatch)
           + R · P                                               — a re-review of each review gate per re-pin that happened after it passed (§3.3, G9)
           + rescue.attempts × (1 + Σ_g review (1 + 2·cycles_g) + Σ_g command cycles_g + R·P)
                                                                  — each rescue pass is one rescue dispatch plus the whole list under fresh cycle budgets
           + integration.cycles                                   — one fix dispatch per integration fix cycle
           + retry.attempts                                       — the ONE infrastructure pool, shared (publish retries draw on it too)

suite runs ≤ Σ over command gates g of (1 + cycles_g)·(1 + reruns_g)·(1 + rescue.attempts)
           + C · P                                               — a re-judge of each non-opted-out command gate per re-pin after its pass
           + (1 + integration.cycles)·(1 + integration.reruns) + RACE_RETRY_CAP
```

Worked: every §2.1 default, ONE review gate with `cycles: 2`, no command
gates, no rescue, no integration — the only re-pins are the review's own fix
cycles, whose re-review is already in the `2·cycles` term, so `R·P` adds
nothing: `1 + (1 + 2·2) + 1 = 7` dispatches, not the 2 an earlier draft
claimed. Add ONE command gate `cycles: 1` declared AFTER the review: the
command gate's fix cycle can re-pin once after the review passed, so
`P = 1`, `R·P = 1`, and the bound is `1 + 5 + 1 + 1 + 1 = 9` — the ninth
dispatch is the re-review that keeps the command-gate fixer from altering
what the review accepted (F16). With no review gate at all it is
`1 + 1 = 2`.

**Reconciled (D7).** The shipped pipeline realizes the tip rule by
restarting from gate 0 whenever a fix cycle moves the head. A gate already
passed at the current head stands, and a review is never re-dispatched at a
head it approved. Fix cycles are charged cumulatively against each gate's cap
across restarts, so WORKERS.md §10.10 states the canonical bound as "the whole
pipeline runs at most the sum of the caps". The formula above remains a
correct UPPER bound on dispatches, because every re-pin is still paid for by
a bounded cap. The worked 7 and 9 are this design's arithmetic and are not
pinned by a shipped test. A command gate declaring `rejudge_on_repin: false`
under controller completion RETAINS its pass on a proven ancestor of the tip
(WORKERS.md §10.14: ancestry verified, original head and candidate kept,
signed in the attestation as `policy_consistent`). It does not re-run.

---

## 6. Migration

### 6.1 `lib/shell/worker-contract.js`

`workerContract({nodeId, factory, terminal})` gains an `implementation` branch
and a `completion` branch. **"Legacy" means a factory that declares NEITHER
`implementation:` NOR `completion:`** — that factory's prompt is byte-identical
to today's, and a golden pins it. Either key present changes the prompt; the
table says which part:

| declared | step 3 (verify) | step 5 (resolve / submit) | routing & budget |
|---|---|---|---|
| neither | every command gate (today) | resolve: resolver node + `resolves` edge + status (today) | worker's (today) |
| `completion.by: controller` only (E10) | every command gate (today) | **submit**: resolver node, NO `resolves` edge, no status flip | worker's (today) |
| `implementation:` (⇒ `by: controller` by default) | `author_checks` only | submit | the stage's |
| `implementation:` + `completion.by: agent` | `author_checks` only | resolve (today) — an operator who wants the lane's routing but keeps agent completion | the stage's |

Three edits:

- **step 3 (verify)** under an `implementation:` block lists only
  `author_checks` gates instead of every command gate, and NAMES the ones it is
  deliberately not asking for: "the factory runs `npm test` from the trusted
  ref's copy after you finish — do not run it here." A prompt that merely omits
  them invites an agent to run them anyway.
- **step 5** under `completion.by: controller` is replaced with a **candidate
  submission** instruction: commit on the branch you were launched on, leave
  the tree clean, write the resolver node with NO `resolves` edge and do not
  flip the item's status; the factory writes both if and only if the gates and
  the integration stage pass, and an edge written anyway is inert under the
  item's execution hold and retyped (§4.5).
  **Reconciled (D1):** as shipped, the resolver node carries a `relates-to`
  edge to the item (not "no edge"), and the final report opens with the fixed
  form `CANDIDATE: <resolver node id> — <why>` (`CANDIDATE_FORM` in
  lib/shell/worker-contract.js).
  The `DECLINED:` fixed form, the one-turn notice and the durable-flag
  checklist are unchanged.
- **workspace** gains the branch/commit expectation that makes a candidate
  pinnable: commit on the branch you were launched on, leave the tree clean.

`ONE_TURN_NOTICE` and `renderDurableFlagChecklist` are shared strings today and
stay shared — the fix-cycle, rescue and dirty-tree round-trip prompts must not
drift from the stage prompt.

### 6.2 Factory / schema validation

`lib/seed/candidates/schema-factory.md` gains `implementation`, `completion`
and the per-gate `rejudge_on_repin` in its documented payload and a CalVer
`schema_version` bump. It stays in the CANDIDATE pack and stays `proposed` on
adoption — **this document activates nothing**. `parseFactory` calls
`parseImplementation` and merges its errors, the same three-line shape
`parseIntegration`/`parseRescue` already have. The `validate()` verb in the
schema node is not extended to re-check the block: the runner's parser is the
enforcement point, and a second partial copy in sandboxed JS is exactly the
drift norm-cc-registry-is-contract exists to avoid.

### 6.3 Command-gate mapping

Today: every command gate → the implementer's prompt. After: `author_checks`
only, defaulting to none, whenever an `implementation:` block is declared. The
mapping code (`commandGates` in worker-contract.js) stays; its INPUT becomes
the filtered list. A factory with no `implementation:` block passes the
unfiltered list, so that part of its prompt is byte-identical — and a factory
with neither key is byte-identical throughout, the property the conformance
posture in this repo asks for (norm-cc-byte-identical-refactor) and the one a
golden test pins.

### 6.4 Premature resolution

Specified in §4.5. In one line: the GUARANTEE is the execution hold, which
makes a premature edge and a premature terminal status inert on both halves
of liveness in both modes; prevention is the prompt (§6.1), detection is the
claim snapshot compared at submission and at every poll, remediation is the
retype (`resolves` → `relates-to`) in both modes plus the status restore, and
enforcement — refusing the write in the first place — is the seed
`transitions()` gate and `setStatusLocal` for the status half, and hosted
mode's door for the edge half (§7.5). A refusing pipeline then leaves the item open, unresolved and
blocked (§4.4); it never degrades to today's demoted-but-still-resolved state.

### 6.5 Status, attempt reporting and resume records

Additive run-record fields, following WORKERS.md §8's additive-only rule:

- **`impl_claim`** — ONE object, ONE stamp, riding the record's CREATION
  write (`cmdDispatch` gains an optional `ctx.recordFields` beside
  `ctx.onLaunch`, merged into the record before its first write), so a
  record either has all of it or was not created by a stage launch:
  `{execution_id, claimed_at, completion: {by, after}, publish: {kind,
  bundle_store | remote_url}, factory: {node_id, revision}, resolving_snapshot,
  status_snapshot}`. Everything §7.2 pins is in here; nothing pinned is
  re-derived from the factory node later (an edit mid-pipeline changes
  nothing), and — the F13 case — the PUBLISH POLICY is part of the pinned
  record, so a missing `publish_pending` stamp is never ambiguous between
  "deliberately unpublished" (impossible: there is no `none`) and "failed":
  a candidate with `commit` set and no `reference.verified_at` is a publish
  owed under `impl_claim.publish`, whatever flag did or did not land.
- `impl_state`; `impl_attempts[]` (`{index, run_id, outcome, pool,
  started_at, finished_at}` — `outcome: "pending", pool: null` from launch,
  settled in one stamp at classification, §5.3); `impl_budget`;
  `impl_candidate` (the §3 tip); `impl_candidates[]` (the chain).
- **`gates_state`** — the settled verdict of the gate LIST alone
  (`passed`/`failed`/`blocked`), stamped by the runner when the list settles
  and BEFORE the integration stage starts; and **`integration_state`**
  (`running`/`landed`/`parked`/`failed`/`refused`), stamped by
  `runGateAndIntegration`. Today both are folded into ONE `gate_state` after
  the combined promise resolves (bin/spor.js `runGateAndIntegration` returns
  the integration result as the pipeline's state, and the caller stamps it
  once), so `gate_state: passed` cannot say WHICH boundary was passed. The
  fold is kept for every legacy reader; the two new fields are what the
  completion predicate below reads.
- `completion_debt`, `publish_pending`.

`spor work --status` and `spor runs --json` surface them beside the `gate_*`
family.

**Reconciled (D10).** `impl_claim` gained further ADDITIVE fields from the
execution-store adapter (WORKERS.md §10.15): `store`, `tenant`,
`pipeline_attempt`, `fence`, `lease_expires_at`, `worker`, `machine` and
`gates`. A claim with no `store` predates the adapter; it reports nothing to
any store and completes exactly as §4.3 describes. The execution id is
derived from `(tenant | "local", node_id, factory, pipeline_attempt)` and
pinned in `impl_claim.execution_id`, never recomputed on resume. The claim
reserves attempt 1 (`pending`) in its creation write and stamps `impl_budget`
with only the ceilings the factory DECLARED. Retyped premature sources are
recorded as `completion_premature`, and a candidate's publish tries as
`publish_attempts[]` on the candidate itself. `integration_state` also
admits `mismatch`.

**Old records have none of these**, and that is the migration: a record with no
`impl_claim` is a legacy run, read as `completion.by: agent` — it already
wrote its resolver, `shouldGate` still gates it, and §10.7 still demotes it on a
refusal. (A record with `impl_state` and no `impl_claim` cannot be produced by
this design — the two ride one write — and is treated as corrupt: the resume
refuses it loudly and names the run.) A resumed pipeline joins on `gate_state`
exactly as today. No record is rewritten, and nothing in
`journal/work/*.work.json` changes shape.

**`completion_debt` is ONE string field, not a set of booleans**: `"retract"`
(a premature edge is owed its retype, §4.5), `"write"` (the boundary was
reached and the edge + status are owed, §4.3), `"withdraw"` (our edge exists
on an item that went `abandoned` under us and is owed its retype back), or
`null`. Every transition is a single stamp that OVERWRITES the field, so
there is never a clear-one-flag-then-owe-the-next pair of writes. It is
designed against all four modes at once:

- **(a) the flag write itself fails.** The debt is never only the flag: it is
  re-derivable from the run record's settled fields plus the graph, and the
  per-pass reconciliation hook (the same slot `checkProposals` occupies)
  derives it for every record whose `impl_claim.completion.by` is
  `controller`. The derivation reads the PINNED boundary, never `gate_state`
  alone (the F12 case — `gate_state: passed` with `after: integration` and an
  integration still running must derive NOTHING):

  ```
  boundaryReached(record) =
       record.impl_claim.completion.after === "gates"
         ? record.gates_state === "passed"
       : record.integration_state === "landed"
         || (record.integration_state === "parked"
             && landed art-merge-… fact for this run is present on the graph)   // checkProposals' own evidence, §10.9
  write    owed ⇔ boundaryReached(record)
                  ∧ impl_state === "candidate" ∧ impl_state not mismatch
                  ∧ ¬(item carries no `execution:` hold ∧ item is terminal ∧ resolved per resolutionMap)
  retract  owed ⇔ item carries our `execution:` hold
                  ∧ some inbound resolves|answers edge's source ∉ impl_claim.resolving_snapshot
                  ∧ that edge's type is still resolves|answers
  withdraw owed ⇔ our resolver (impl_candidate.resolver.node) carries a `resolves` edge to the item
                  ∧ item.status === "abandoned"
  ```

  With `after: integration`, `gates_state: passed` and `integration_state:
  running`, `boundaryReached` is false and no `write` is derived; the same
  inputs under `after: gates` derive it — which is the declared meaning of
  that boundary (§2.1). The flag is an accelerator for the common pass; the
  derivation is the record of last resort — the same posture
  `gate_demote_pending` takes.
- **(b) clear-before-owe ordering and the crash window.** OWE FIRST: the field
  is stamped `write` BEFORE step 1 of §4.3 is attempted and set to `null` only
  after a re-read shows BOTH the edge and the terminal status landed. A crash
  between the edge and the status leaves `write` set; the next pass re-reads,
  finds edge-present / status-lagging, and performs only step 2 (idempotent).
  A crash between the retype and the status restore under `retract` likewise
  leaves `retract` set and the next pass finishes the half that is missing.
  Moving from one debt to another (`retract` → later `write`) is one
  overwrite, never a clear plus a set.
- **(c) the check-then-write race.** Closed by TWO things together, because
  the two halves of the race are observable by different means (§4.3): a
  status move on the item by anyone (a person's `abandoned` or `done`,
  another worker's completion, a heal pass) moves the item's `revision`, so
  the CAS in §4.3 step 2 turns it into a `409`, a re-read, and a branch
  (withdraw / consume / bounded retry), never last-write-wins; and a
  resolving EDGE added from any other resolver — which does NOT move the
  item's revision, since it lives on the source node — is inert under the
  item's execution hold until step 2 clears it, and step 2 belongs to the
  execution named in the hold. So there is no interleaving in which a foreign
  resolver retires the item between our read and our write: the only write
  that can retire it is the one that clears the hold, and that write is CAS'd.
  The edge writes contend with nobody because they are on OUR resolver node.
  Ownership of the attempt is the same rule the gate stamps already keep:
  only the worker holding the run's pipeline — or the explicit `spor work
  --regate` door — attempts it; in hosted mode the fence (§7.1 `owner.fence`)
  makes that exclusive rather than conventional. The `retract` path has no
  CAS on the ITEM (it writes the resolver), and needs none: a retype that
  finds the edge already gone is `skipped`, and the status restore is a CAS
  on the item like step 2.
- **(d) a stale flag against already-settled state.** Every pass RE-READS
  before acting: `write` against an item already carrying a live resolving
  edge from our resolver and a terminal status ⇒ consumed without writing;
  `write` against an item resolved by a DIFFERENT candidate that landed (a
  duplicate item merged, a person's own resolution) ⇒ consumed, our resolver
  left as `relates-to` provenance; `write` against `abandoned` ⇒ becomes
  `withdraw` (one overwrite) and then runs; `retract` against an edge already
  gone ⇒ consumed; any debt against a run record whose `gate_state` is
  `superseded` ⇒ consumed. Reconcile against the settled state; never act on
  the flag blindly.

**The `execution:` hold** (§4.5), **`impl_attempts[].pool`** (§5.3) and
**`publish_attempts[]`** are durable flags too, and each is answered on the
same four rows:

- `execution:` — **(a)** the stamp fails: H2 — no hold means no launch, the
  lease is released, and nothing is owed because nothing started; a hold is
  never re-derived — it is on the item or the pipeline does not exist. **(b)**
  the hold is cleared only by the completion CAS that writes the terminal
  status in the SAME `put_node` (§4.3 step 2), by the withdraw / unroutable
  branches that clear it ALONE on a fresh revision, or by a person's explicit
  release; there is no clear-hold-then-write-status pair anywhere. **(c)**
  every write of the key is a CAS on the item's revision (blob sha locally),
  so two claimers of one item cannot both stamp (the second is a `409`, H2)
  and a release racing a completion is observed by whichever write comes
  second (§4.3's `409` branches). **(d)** a hold whose execution is settled is
  cleared by the settling write itself; a hold whose worker is dead reads
  `stale` and is fail-closed — the item stays live on both halves, never done
  — until adopted by run name or released; a hold found on an item already
  `done` with our edge present is §4.3's done-with-hold-present branch (a
  hold-clear-only CAS, consumed).
- `impl_attempts[].pool` — **(a)** the settle stamp fails: the entry stays
  `pending`, the caps read it as unspent, and the next pass re-classifies the
  same record (the classifier is pure over the record) and re-stamps — the
  debt is the record's own `terminal_state`, which the settle only summarizes.
  **(b)** outcome and pool are ONE stamp; a `pending` entry never has a pool
  and a settled one always does. **(c)** the stamp is keyed on `run_id` and
  refused when the entry is already settled, so a resumed worker beside a
  not-quite-dead one charges once. **(d)** a `pending` entry whose run record
  is `superseded`, `declined`, or adopted by a rescue is settled by that pass
  with the outcome the record shows, never left to be counted as a free
  launch.
- `publish_attempts[]` — the same four answers, with the entry keyed on
  `(candidate_id, index)` and the retry cap read against settled entries
  across BOTH arrays, since the pool is one (§5.3).

**`publish_pending`** (§3.4) is designed against the same four rows, each
answered on its own:

- **(a) the stamp fails.** The debt is derivable without it: `impl_candidate`
  (or a chain entry) with `commit` set and no `reference.verified_at`, read
  against the PINNED `impl_claim.publish` — which is part of the record's
  creation write and so cannot be missing on a stage record. Because there is
  no `publish: none`, "unpublished" has exactly one meaning: owed. The
  reconciliation hook re-attempts it from the workspace under the retry pool
  (I3a), and a workspace that is gone (a reaped worktree) escalates naming the
  commit, which is still in the repository's object store.
- **(b) clear-before-owe.** The candidate's `reference` is written in the SAME
  stamp that clears `publish_pending`, after the producer's own fetch-and-verify
  round trip (§3.4) — the debt is cleared only by the evidence that discharges
  it. A crash after the object landed but before that stamp leaves the debt
  set; the next pass re-publishes, finds the identical object (sha-equal /
  ref-equal, a no-op), verifies, and stamps.
- **(c) the check-then-write race.** The publish is an exclusive create keyed
  on `candidate_id` (`wx`/`COPYFILE_EXCL`, `--force-with-lease=<ref>:`, the
  hosted door's `409`), so two publishers of one candidate — a resumed worker
  beside a not-quite-dead one — cannot both write: one creates, the other
  finds the object and compares. Equal content is the no-op; different
  content is `publish-conflict` (M2), never an overwrite. This is consistent
  with §3.2 only because the pinned commit is IMMUTABLE — the F14 case: a
  same-tree re-submission with a newer commit changes `commits_seen` and
  nothing else, so there is never a "newer pinned commit" that the immutable
  object fails to carry.
- **(d) a stale flag against settled state.** A `publish_pending` on a
  candidate that a re-pin has SUPERSEDED is consumed without publishing (the
  tip is what readers fetch; the ancestor's facts already name its id and
  need no object — `art-gate-*` facts carry the tree, which is the evidence);
  one on a run whose `impl_state` is `mismatch`/`escalated`/`exhausted` is
  consumed; one whose object turns out to exist and verify is consumed by the
  verify, not by a second write.

### 6.6 Tests

Named because criterion 4 asks for them; each is a unit or table test in the
existing suites (`test/gates.test.js`, `test/gate-pipeline.test.js`, a new
`test/implementation-stage.test.js`), all against scratch `SPOR_HOME`s and fake
dispatchers — no live graph, no paid model call. Row ids refer to §4.2.

1. **premature resolution (H1, P1, §4.5)** — the review's own probe, made a
   test: an in-memory graph (`lib/kernel/graph.js` + `lib/kernel/queue.js`)
   with `task-up` blocking `task-down`, `task-up` under `execution: exec-1`,
   an early `resolves` edge onto `task-up` from the implementer's resolver:
   `resolutionMap` has NO entry for `task-up`, `rankQueue` does NOT list
   `task-down` as actionable, `render_program` shows it blocked — and the
   same graph with the hold removed lists it (the completion write's effect).
   Then the STATUS half: the same held item with `status: done` written
   (a hand edit in local mode; a fake server's `set_status` in remote mode)
   is still `isLive`, `blockingCount` still counts it, `task-down` is still
   blocked, and the remote `set_status` is refused by the seed
   `transitions()` gate naming the execution while the completion CAS
   (status + hold removal in one body) passes.
   Then the retype: the edge is retyped `relates-to` in LOCAL mode (file
   rewrite) and in REMOTE mode (a fake server records the `DELETE` then the
   `POST`), the status is restored, `premature_resolution` is recorded, no
   gate runs before the retype, a refusing pipeline leaves the item open,
   held, with no resolving edge and the dependent still blocked; a passing
   one re-adds the edge once on the same resolver and clears the hold in the
   same `put_node` as the status. A hold whose worker is dead reads `stale`
   in `--status`, never `done`; `spor release --execution` clears it.
2. **exhausted budget (I9-I11)** — `budget.attempts: 1` and a `failed`
   outcome: exactly one dispatch, then `impl_state: exhausted`, one escalation
   `blocks` the item, no completion. And with `attempts: 2` a `no-candidate`
   then a `cancelled`: two dispatches, then exhausted.
3. **infrastructure vs code (I1, I7-I9, G6-G7)** — a launch reserves an
   attempt with `pool: null` and the caps read 0 spent; an `environment`
   termination then settles it `{infrastructure, retry}` — `retry` spent 1,
   `budget.attempts` spent 0 (the F15 case); a plain nonzero exit settles
   `{failed, budget}` — the reverse; a resume that re-classifies a settled
   entry changes no count; ambiguity classifies `failed`; a review dispatch
   that classifies `infrastructure` is re-made without charging the gate's
   cycle, and the pool is shared (a retry spent on the implementation is not
   available to the review); a failed publish (I3a) draws on `retry` on a
   `publish_attempts[]` entry and re-runs the publish without a second
   implementer dispatch, while the run's single `impl_attempts[]` entry stays
   settled `{candidate, implementation}` — two publish failures read
   `budget.attempts` 1 / `retry` 2, never 3 / 0 (the F15 double charge).
4. **refusal is not an attempt (I2)** — a launcher ENOENT and a
   satisfiability refusal both leave `impl_attempts` empty, spend neither
   pool, cool the item and name the cause on stderr.
5. **cancelled execution (I10)** — a run past its `impl_budget.run_idle_ms`
   is stopped by `pollWorkRuns` while a sibling gate dispatch with no stamp is
   judged by the worker-global ceiling; the lease is not released by the stop;
   the slot frees; the attempt is charged.
6. **missing candidate evidence (I3-I5, M1-M2)** — a terminal run with no
   commit past the merge base, and one with a dirty tree under
   `require_clean`: no gates run, no completion, the report artifact still
   filed; a bundle whose fetched commit's tree ≠ `tree` (a corrupted store)
   is `candidate-mismatch`: `impl_state: mismatch`, an escalation `blocks`
   the item naming both trees and the locator, the hold stays, neither pool
   moves, no gate runs (M1); a producer whose own post-publish verify fails,
   and a store already holding a different object under the id, end the same
   way (M2); a candidate whose publish never verified is NOT `impl_state:
   candidate` and starts no gate. Then portability (F11): a candidate
   published to a `file://` store from home A is fetched into a scratch
   repo under a SECOND `SPOR_HOME` B from `reference.locator` alone — A's
   worktree deleted first — and `rev-parse <commit>^{tree}` equals `tree`;
   a producer that offers a locator under `provenance.cwd`, a relative path,
   a remote name or a bare sha has it refused and lands in I3a with the
   reason named.
7. **candidate identity, chain and the tip rule (§3.2-3.3, G9-G11)** — the
   same tree re-committed yields the same `candidate_id`, the pinned `commit`
   and `reference` are UNCHANGED, the new commit lands in `commits_seen`, no
   second publish is made (the fake store counts one create) and the facts are
   idempotent (the F14 case); a rebase onto a moved base yields a new
   candidate and a new object; a fix cycle re-pins with `supersedes` set; the
   gate fact after the fix names the new candidate while the earlier gate's
   fact names the ancestor. Then the F16 case: a review gate passes on
   candidate A, a LATER command gate fails and its fix cycle re-pins to B —
   before `accepted`, the review is dispatched again on B as a fix-cycle
   review carrying A's ledger and the A..B commits, the fake dispatcher counts
   that re-review, and a `changes_requested` on it enters the REVIEW's fix
   cycle; a command gate re-judges on B by default and a `rejudge_on_repin:
   false` one does not and its fact names A; integration merges the pinned
   commit and the `art-merge-*` fact names the tip.
8. **old definitions** — a factory with neither key produces a byte-identical
   worker contract string and an identical dispatch argv; `completion.by:
   controller` alone changes ONLY the completion step of the prompt; a run
   record with no `impl_claim` resumes and completes exactly as today.
9. **completion boundary (C1-C4, N7-N9, §6.5 (a))** — `after: gates` with no
   integration completes at the last gate; `after: integration` completes only
   after the land, and the derivation over a record with `gates_state:
   passed`, `integration_state: running`, `after: integration` and no
   resolver yields NO debt (the F12 case) while the same record under `after:
   gates` yields `write`; `after: gates` WITH integration completes first and
   a post-completion integration failure files a `relates-to` item and does
   not demote; a `parked` proposal completes only when `checkProposals` sees
   the merge; a refusal at any stage writes NO resolving edge and clears no
   hold, so a dependent item stays blocked.
10. **the CAS (§4.3, §6.5 (c))** — a fake server that bumps the item's
    revision between the read and the `put_node`: an `abandoned` flip ends in
    `withdraw` (the edge retyped back, the hold cleared) and no status write;
    a `done` flip with the hold gone is consumed with no write; a `done` flip
    with the hold still present is consumed by a hold-clear-only CAS; a
    priority bump retries once and lands; a fourth consecutive `409` leaves
    `write` owed. The F2 case: a resolving edge from a DIFFERENT resolver
    added between the read and the write, revision unchanged — the `put_node`
    lands, and until it did `resolutionMap` had no entry for the item (the
    foreign edge was inert); afterwards P1's rule has retyped it, and the
    completion names our candidate. Local mode: a hand edit between the read
    and the write is caught by the blob-sha compare.
11. **validation table (§2.4)** — every V/E row, table-driven, including E7's
    unreachable boundary, E11-E13 and V6's logged boundary.
12. **`completion_debt` and `publish_pending` (§6.5)** — each of (a)-(d) for
    both: a stamp write that fails and is re-derived (for publish: from
    `impl_claim.publish` + a candidate with no `verified_at` — the F13 case, a
    record with a failed pending stamp is NOT byte-equal to a settled one
    because its candidate has no verified reference); a crash between edge
    and status resumed with only the status written; a crash between the
    object landing and the reference stamp re-publishes as a no-op and
    verifies; a stale `write` against an item resolved elsewhere; a stale
    `retract` against an edge already gone; a stale `publish_pending` on a
    superseded candidate consumed without a write; `superseded` consuming any
    completion debt; two publishers of one candidate producing one object.
13. **dispatch bound (§5.4)** — a fake dispatcher counting launches for the
    worked examples lands on exactly 7, and on exactly 9 with the trailing
    command gate.
14. **the claim pins (H1-H2, §6.5)** — a failed hold stamp makes no dispatch
    and releases the lease (`unroutable`); a run record created by a stage
    launch always carries `impl_claim`; a factory node edited mid-pipeline
    changes neither the boundary nor the publish policy the record enforces;
    an item already holding a LIVE foreign execution is refused at H1 (no
    second hold, no dispatch), a stale foreign hold is not taken by a fresh
    claim, and a `409` at the completion CAS that re-reads a different
    execution's hold withdraws our edge and writes nothing on the item.

### 6.7 What is preserved, explicitly

Trusted-ref execution (`trusted_ref`, protected paths forced back, the suite is
never the branch's copy), the protected-path fail-closed lane, review
independence (profile-routed, cross-model, read-only — and now bound to the
TIP: no later fixer can alter what a review accepted without the review
re-judging it, §3.3), `repos` scoping, the rescue lane, `--regate`, the
shipped fix-cycle scope (only the failed gate re-runs, WORKERS.md §10.4 —
the acceptance re-judge is a separate step at G9, not a widening of the fix
cycle), and the whole §6 terminal-state contract. This stage adds a producer
in front of them; it relaxes none of them.

---

## 7. The contract task-spor-hosted-factory-execution-state consumes

**Reconciled (D11).** This section is what the hosted task was handed, and
the hosted task has since shipped it as spor-server's EXECUTION-STATE.md
(dec-spor-hosted-execution-state-server-authoritative). The client port of
that reducer is `lib/kernel/execution.js`, and it must stay byte-identical to
the server's. That realization is now the contract. Where it differs from
§7.1-§7.5 below, it wins:

- **Stage enum.** It is the coarse `implementation | gating | integration |
  completed | refused`. `exhausted`, `escalated` and `mismatch` are stage
  VERDICTS on the run record (`impl_state`), not store stages. Attempt pools
  are `implementation | retry | cycle | rescue`.
- **Event vocabulary.** It is exactly: `stage.started`, `stage.observed`,
  `candidate.submitted`, `candidate.superseded`, `candidate.published`,
  `gate.started`, `gate.settled`, `rescue.started`, `integration.started`,
  `integration.settled`, `escalation.filed`, `completion.written`. There is
  no `resolution.retracted` and no `completion.withdrawn`. A retype is
  evidence repair on the graph, and a withdrawn, consumed or person-released
  completion ENDS the execution the way a refused hold does. Two log-only
  entries (`execution.opened`, `ownership.changed`) let the log rebuild the
  record.
- **Idempotency keys.** `derivedEventKey`: a gate outcome is
  `<execution_id>:<gate_id>:<attempt>`, and `gate.settled` names the judged
  `candidate_id` as a FIELD, which is required after a re-pin.
  `candidate.submitted`/`.superseded` key on the bare `candidate_id`, and
  `candidate.published` on `<execution_id>:published:<candidate_id>`. `completion.written` is
  `<execution_id>:completion`. There is no retraction key.
- **Ids.** `exec-` plus 16 hex of sha256 over the NUL-joined
  `(tenant, node_id, factory, pipeline_attempt)`. The local tenant is the
  literal `local`. This is NOT the newline-terminated key that
  `candidate_id` uses, and the two must not be harmonized.
- **Write-side refusal.** §7.5's refusal shipped: a `resolves`/`answers`
  edge into an item whose live execution has not reached its pinned boundary
  is refused with `409 execution_boundary`.
- **Candidate door.** §7.5's `https://` door is the hosted server's to
  define. The client defaults to a machine-local `file://` store in both
  modes (D3) and reaches the door only through a declared `bundle_store`.

**7.1 The execution record** (one per `(item, factory, pipeline attempt)`),
versioned `spec_version: 1`:

```json
{
  "spec_version": 1,
  "execution_id": "exec-<sha256-16 of tenant, node_id, factory, pipeline_attempt>",
  "tenant": "<org>",
  "item": { "node_id": "task-…", "revision": "<node sha>", "repo": "spor",
            "resolving_snapshot": [], "status_snapshot": "open",
            "hold": { "key": "execution", "value": "exec-…", "since": "…" } },
  "factory": { "node_id": "factory-…", "revision": "<node sha>",
               "completion": { "by": "controller", "after": "integration" },
               "publish": { "kind": "bundle", "bundle_store": "https://…/v1/executions/exec-…/candidates" },
               "gates": [{ "id": "acceptance", "node_id": null, "revision": null, "rejudge_on_repin": true }] },
  "stage": "implementation|gating|integration|completed|refused|exhausted|escalated|mismatch",
  "attempts": [ { "index": 1, "pool": "implementation|retry|cycle|rescue|integration|null",
                  "stage": "implementation", "run_id": "…", "state": "…",
                  "outcome": "pending|candidate|no-candidate|failed|infrastructure|cancelled|declined|candidate-mismatch",
                  "started_at": "…", "finished_at": "…" } ],
  "candidate": { "…": "the §3 TIP (reference verified), or null" },
  "candidates": [ "…the chain, oldest first, each the §3 object…" ],
  "verdicts": [ { "gate": "adversarial-review", "candidate_id": "cand-…", "state": "passed", "on_tip": true } ],
  "gates_state": "passed|failed|blocked|null",
  "integration_state": "running|landed|parked|failed|refused|null",
  "pools": { "implementation": { "cap": 1, "spent": 1 }, "retry": { "cap": 1, "spent": 0 } },
  "owner": { "worker": "…", "machine": "…", "lease_expires_at": "…", "fence": 7 },
  "completion": { "boundary": "gates|integration", "debt": "retract|write|withdraw|null", "written_at": null }
}
```

`item.hold` is the execution hold of §4.5 as the server sees it; `verdicts[]`
is the per-gate `{candidate_id, on_tip}` the acceptance check (G9) reads —
`accepted` requires every entry `on_tip: true` except a command gate pinned
`rejudge_on_repin: false`; `pools.*.spent` counts settled attempts only
(`pool` non-null) — `retry.spent` across `attempts[]` AND every candidate's
`publish_attempts[]`, `implementation.spent` across `attempts[]` alone
(§5.3).

**7.2 Pinned revisions.** `item.revision`, `factory.revision`,
`factory.completion` and each gate node's revision are pinned at CLAIM time
and carried unchanged through the pipeline. An edit to the factory node
mid-pipeline does not change what the running execution enforces; the next
pipeline picks the new revision up. This is the criterion the hosted task
states as "ordinary node edits cannot forge successful acceptance", and it is
met here by pinning, not by trust.

**7.3 Events**, ordered, each carrying `execution_id`, a monotonic `seq` and an
`idempotency_key`: `stage.started`, `stage.observed`, `candidate.submitted`,
`candidate.superseded`, `candidate.published`, `resolution.retracted`,
`gate.started`, `gate.settled`, `rescue.started`, `integration.started`,
`integration.settled`, `escalation.filed`, `completion.written`,
`completion.withdrawn`. A replayed event with a seen key is a no-op — the
reason every id in §3 and §7.1 is content-addressed.

**7.4 The idempotency keys**: `execution_id` (above), `candidate_id` (§3.2,
content-addressed on the tree), `<execution_id>:<gate_id>:<attempt>:<candidate_id>`
for a gate outcome, `<execution_id>:completion` for the completion write,
`<execution_id>:retract:<source node>` for a retraction.

**7.5 What the server may do that this client cannot**, and which this design
deliberately leaves to it: **refuse or hold a `resolves`/`answers` write into
an item whose execution has not reached its completion boundary** (§4.5's
write-side enforcement — the client makes such a write inert through the
shared read rule and retypes it after the fact; the server can decline it at
the door, and applies the same hold rule for readers that are not this lib);
perform §4.3's steps 0-2 atomically under the execution's `fence`; atomically
fence two workers off one execution; and hold the candidate object — the
`https://` `bundle_store` door is `PUT
/v1/executions/{id}/candidates/{candidate_id}` with the bundle bytes,
answering `201` on create, `409` when the id already exists with different
bytes (the client's `publish-conflict`) and `200` when it exists with the
same `sha256` (the replayed no-op), and `GET` of the same path — which the
hosted task defines and this client consumes.

**7.6 Local mode stays first-class.** The same record shape is what
`journal/work/` and the run record hold today plus the additive fields in §6.5 —
the hosted store is a different HOME for this contract, never a different
contract. A client that cannot reach the server keeps its local evidence and
reconciles on reconnect; it never writes a completion it does not own.

---

## 8. Implementation breakdown

Bounded, six items, all in `repo-spor` except where noted. Each is filed as a
task node with the edges named here (criterion 5's "genuine prerequisites
recorded as edges").

| # | task | files | prerequisites |
|---|---|---|---|
| 1 | parse the stage — `parseImplementation`, `completion`, `rejudge_on_repin`, §2.4's table, the schema-factory candidate bump | `lib/kernel/gates.js`, `lib/seed/candidates/schema-factory.md`, `test/gates.test.js` | this design |
| 2 | the candidate object — content-addressed id, the re-pin chain, the two reference kinds with fetch+verify, the immutable pinned commit, additive run-record fields, `spor work --status`/`spor runs --json` surfacing | `lib/shell/work-loop.js`, `lib/shell/agent-dispatch-runner.js`, `lib/shell/gate-runner.js` (`pinCandidate` beside `readChanged`), `bin/spor.js`, `WORKERS.md` §8 | 1 |
| 3 | controller completion — the execution HOLD (`executionHeld` in `lib/kernel/resolution.js`, applied in `resolutionMap` — the edge half — and in `queue.isLive` — the status half — plus the `get_node` surface's short-circuit, the schema-task `get()` twin, the schema-task `transitions()` refusal of `done` under a hold and `setStatusLocal`'s twin; H1's CAS stamp; `spor release --execution`; the stale-hold read in `--status`/`spor get`), the CAS boundary write that clears it, `completion_debt` and its reconciliation hook (the `boundaryReached` predicate over `gates_state`/`integration_state`), the worker-contract split, the retraction door (`removeEdgeLine` + the remote `DELETE`), the one-write `impl_claim` pins (`ctx.recordFields`), the poll-time detection | `lib/kernel/resolution.js`, `lib/kernel/queue.js` (`isLive`), `lib/kernel/graph.js` (the get surface), `lib/seed/schema-task.md` (get + transitions hooks, CalVer bump), `lib/shell/worker-contract.js`, `lib/shell/gate-runner.js`, `bin/spor.js` (`setStatusLocal`), `WORKERS.md` §10, `GRAPH.md` (the `execution:` key) | 1, 2 |
| 4 | `classifyExecutionOutcome` + the two pools (one shared infrastructure pool per pipeline; charged at classification, reserved at launch), the refusal-is-not-an-attempt rule, and its adoption by the review gate | `lib/kernel/gates.js`, `lib/shell/gate-runner.js`, `lib/shell/work-loop.js` | 1; relates to issue-spor-review-gate-reviewer-outage-read-as-rejection |
| 5 | per-record budget — `impl_budget` stamped at launch, `pollWorkRuns` resolving per-record ceilings; the split `gates_state`/`integration_state` stamps beside the kept `gate_state` fold | `bin/spor.js` (`pollWorkRuns`, the launch stamp, `runGateAndIntegration`), `lib/shell/work-loop.js`, `lib/shell/gate-runner.js`, `WORKERS.md` §8 | 1 |
| 6 | candidate publication (`bundle` default, `branch`, `both`; `file://` + `https://`; the exclusive-create CAS; the producer's fetch-and-verify), `publish_pending`, the startup store/remote checks (E9, E14), integration merging the pinned commit | `lib/shell/integration-runner.js` (the git helpers), `bin/spor.js`, `lib/shell/home.js` (the `/candidates/` gitignore line) | 2 |
| 7 | the tip rule — `verdicts[].on_tip`, the G9 re-judge step (review as a fix-cycle review; command as a suite run), `rejudge_on_repin`'s opt-out, the `R·P` bound | `lib/shell/gate-runner.js` (`judge`, after the ordered pass), `lib/kernel/gates.js` | 1, 2, 4 |

**Reconciled: what shipped against this breakdown (2026-09-27).** Items 1-6
shipped as their own tasks: 1 as task-spor-factory-implementation-stage-parser
(`parseImplementation`); 2 as task-spor-factory-candidate-record
(`lib/kernel/candidate.js`, `pinCandidate`); 3 as
task-spor-factory-controller-completion-boundary
(dec-spor-factory-controller-completion-hold-and-cas;
`lib/kernel/completion.js`, `lib/shell/completion.js`); 4 as
task-spor-factory-execution-outcome-classifier (`classifyExecutionOutcome`);
5 and the stage loop as task-spor-factory-implementation-stage-runner
(`lib/shell/implementation-stage.js`); and 6 as
task-spor-factory-candidate-portable-reference
(`lib/shell/candidate-publish.js`). Item 7 shipped by a different route: the
commit-bound gate attestation restarts from gate 0 on a moved head, and
`rejudge_on_repin: false` retains a command pass on a proven ancestor (D7).
The execution-store adapter, which this breakdown did not list, shipped as
task-spor-client-execution-store-adapter. WORKERS.md §10.12-§10.16 documents
all of them.

`task-spor-hosted-factory-execution-state` (repo-spor-server) is unblocked by
**this design**, not by items 1-7: what it consumes is §7's contract, which this
document fixes. Items 1-7 are the client's own realization of the same contract
and proceed in parallel. Wiring them as blockers of the hosted task would stall
it for no contract reason, so they are deliberately not wired that way. The
one thing the server DOES depend on from item 3 is the `resolutionMap` hold
rule, which it inherits by consuming `lib/` — the hosted task's write-side
refusal (§7.5) is enforcement on top of it, not a substitute.

---

## 9. Open product choices — named, not hidden

1. **Whether hosted mode should publish `both` by default.** The default
   everywhere is `bundle` (§2.1) — in hosted mode into the server's candidate
   door — so a hosted controller can always obtain the candidate. Whether it
   should ALSO push a `branch` ref (cheap for a human to fetch; needs write
   credentials on the implementer's box and leaves refs behind) is not
   decided here; §3.4 fixes both shapes and the verify rule so the hosted
   task can add it without a contract change.
2. **Whether `completion.by: controller` ever becomes the default** for a
   factory with no `implementation:` block. It would be a breaking change to
   every adopted factory, so it is a major-version question, not this design's.
3. **Whether a candidate may be judged on a machine other than the one that
   produced it** in LOCAL mode. Every candidate now has a portable reference,
   so the object is obtainable wherever the store reaches; what local mode
   lacks is the FETCH step in the gate-tree preparation (a gate tree is built
   from `record.cwd` today). Item 6 builds that step for hosted mode; whether
   local mode reuses it — so a shared-filesystem `bundle_store` lets a second
   box gate what the first produced — is open.
4. **Whether `budget.attempts > 1` should re-dispatch with the previous
   attempt's report as context.** A blind re-run is the least informative retry
   available (§2.1); feeding the report back makes it a fix cycle in all but
   name, which may argue for deleting the knob rather than improving it.
5. **Where an author check's RESULT goes.** Today an author run is invisible to
   the factory. Having the implementer report it (and the gate skip a suite whose
   author run passed on the identical tree) is a real spend saving and a real
   trust relaxation — out of scope here, and the trust half is exactly what
   §6.7 preserves.
6. **Multi-candidate executions.** One execution holds one TIP candidate (and
   its chain) in §7.1. A lane that wants two implementers racing the same item
   needs a candidate SET and a selection rule; nothing here forbids it later,
   and nothing here provides it.
7. **Whether the `rejudge_on_repin: false` opt-out should exist at all.**
   Under controller completion the default is now `true` and reviews have no
   opt-out (§3.3): acceptance is a property of the tip. The command-gate
   opt-out is kept because a slow suite whose result a declared integration
   stage will re-establish anyway is a real spend case, and it is logged at
   startup and visible on the gate fact. Removing it would make the tip rule
   unconditional; keeping it leaves one declared, auditable exception.

---

## 10. Review-finding ledger — where each blocking finding is closed

The adversarial-review gate carried findings F1-F17 across three fix cycles;
this table is the audit trail from each finding id to the rule that closes it,
so a reader (or the next review) can check the claim without re-deriving it.

| id | the finding, in one line | closed by | the rule |
|---|---|---|---|
| F1 | local mode could not retract the resolving edge, so failed/pending gates released dependents | §4.5, preamble fact 4, §4.2 H1/H2, §8 item 3 | the item is HELD (`execution:`) from H1 to the completion CAS, and `executionHeld` short-circuits BOTH halves of liveness — `resolutionMap` (a premature edge is inert) and `queue.isLive` (a premature `done` is inert) — on every reader in both modes; retraction is evidence repair, not release prevention. A dead worker's hold is fail-closed and reads `stale`, never done |
| F2 | a person or another execution can resolve/abandon between the re-read and the write | §4.3, §6.5 (c) | the status half of the race moves the item's `revision` and turns the completion `put_node` into a `409` with a branch (withdraw / consume / hold-clear-only / different-execution / bounded retry); the edge half cannot move the revision but is inert under the hold until step 2 — which is the execution's own CAS'd write and refuses to run unless the hold it read is ours. H1 refuses a live foreign hold, so two executions never hold one item |
| F3 | `candidate_id` hashed attempt and commit | §3.2 | `sha256(repo, node_id, tree)` only |
| F4 | the pinned candidate was never superseded after fix/rescue/integration | §3.3 | every run that commits re-pins; `supersedes` chain; facts name the candidate they judged |
| F5 | `after: gates` completed before integration with no `completed → integrating` row | §4.2 C1-C4 | the post-completion integration rows, with the no-demotion rule |
| F6 | `by: controller` without `implementation:` claimed byte-identity | §2.4 E10, §6.1 | not byte-identical, and said so: only the completion step changes |
| F7 | stage budget rode `--run-max`/`--run-idle` | §5.1 | `impl_budget` on the run record, read per record by `pollWorkRuns` |
| F8 | a missing launcher was both a refusal and an infrastructure charge | §4.2 I2, §5.3 | a refusal is not an attempt: no record, no pool |
| F9 | no transition after the code pool was spent | §4.2 I11 | `exhausted`, with its escalation |
| F10 | the dispatch bound omitted the initial review and the re-reviews | §5.4 | `1 + 2·cycles` per review, the `R·P` re-judge term, the worked 7 and 9 |
| F11 | the reference was machine-local; the bundle had no URI or object key | §2.1, §3.1, §3.4, §6.6 test 6 | no `local` kind and no `publish: none`; a `bundle` reference carries `store`, `key`, `locator` (an absolute `file://`/`https://` URI), `sha256`, `bytes`, `commit`; a locator under the workspace, a remote name, a bare sha or a relative path is refused; the producer verifies by fetching from the locator into a scratch repo; a second graph home on the same store verifies the candidate after the worktree is gone (tested) |
| F12 | completion debt derived from `gate_state` without the pinned boundary | §6.5 (a), `boundaryReached` | the derivation reads `impl_claim.completion.after` against the split `gates_state`/`integration_state`; `after: integration` + gates passed + integration running derives nothing |
| F13 | a failed `publish_pending` stamp was indistinguishable from a deliberate `none` | §6.5 `impl_claim`, E11 | the publish policy is pinned in `impl_claim` on the record's creation write, and there is no `none`, so "unpublished" has one meaning: owed |
| F14 | one candidate id, two commits, an object that could not carry both | §3.2, §3.4 | the pinned commit is immutable — first published wins; a same-tree re-submission appends to `commits_seen` only; the object is an exclusive create keyed on the id; integration merges the pinned commit |
| F15 | the implementation pool was charged at launch and again at classification | §4.1, §4.2 I1/I3/I3a, §5.3, §6.5 | one `impl_attempts[]` entry per record, reserved `{pending, null}` at launch and settled `{outcome, pool}` in one stamp at classification; publish retries are `publish_attempts[]` entries on the `retry` pool, so a record is never charged the code pool twice and infrastructure never charges it at all |
| F16 | a later fixer could alter what the review accepted | §3.3, §4.2 G9-G11, §5.4 | acceptance is a property of the tip: every agent-review gate re-judges a moved tip (no knob, E13), command gates re-judge by default (`rejudge_on_repin`); a failed re-judge enters that gate's own fix cycle |
| F17 | `candidate-mismatch` had no transition, terminal state or graph write | §4.2 M1-M2, T1, §4.1 | terminal `impl_state: mismatch`, a `requires: [human]` escalation `blocks` the item naming both trees and the locator, status untouched, hold kept, neither pool charged |

---

## 11. Reconciliation against the shipped contracts (2026-09-27)

This design was written at e18e2c9 on an unmerged branch, and every item in
§8 was then built against a copy of it. This section is the record of
landing that text on `main` after the fact. It says what each design
acceptance point now rests on, whether each blocking review finding still
stands against what shipped, and every place the shipped contract diverges
from the text above. The divergences are marked inline with
**Reconciled (Dn)**. Nothing here activates a schema.

### 11.1 The five design acceptance points, preserved

The five points below are task-spor-factory-implementation-stage's own
acceptance, verbatim in substance. Each still holds for this text, read with
the reconciliations.

| # | acceptance point | where it is met |
|---|---|---|
| 1 | A backward-compatible stage shape (profile/harness routing, instructions, revisions, inputs, candidate outputs, budget, bounded retry) with valid and invalid examples and justified defaults; absent configuration preserves existing factories; author checks distinguished from authoritative acceptance | §2.1-§2.4 (V1-V9, E1-E14), §6.1, §6.3; D3 corrects one default |
| 2 | A lifecycle and transition table from implementation through candidate, acceptance, fix/rescue and integration to final completion; the candidate is a pinned commit/tree plus provenance and a portable reference, never a claim of resolution; a configured, reachable boundary, including factories without integration; failed or pending gates release no dependents | §3, §4.1-§4.5 (H/I/P/M/G/C/N/T rows), with D1, D2, D5, D8 |
| 3 | An adapter mapping onto the existing declarative harnesses and shared supervisor (start, observe, cancel, recover, typed outcomes) with no parallel runner; infrastructure separated from code, with the pool each spends | §5.1-§5.4, with D6, D7, D9 |
| 4 | A migration plan (worker contract, factory/schema validation, command-gate mapping, status/attempt reporting, old resume records) and named tests (premature resolution, exhausted budget, cancelled/failed execution, missing candidate evidence, old definitions); independent review and trusted execution preserved | §6.1-§6.7; the shipped tests are listed in WORKERS.md §10.12-§10.16 |
| 5 | A bounded breakdown with file/repo ownership and prerequisites as edges; the exact contract the hosted execution task consumes; open product choices named | §7 (with D11), §8 (with its shipped mapping), §9 |

### 11.2 The review findings F1, F2, F11-F17, adjudicated against what shipped

F3-F10 were closed in the design's earlier cycles and are not re-opened; §10
indexes them. The remaining nine were the blocking set at e18e2c9. Each one is
judged below against the code on `main`.

| id | verdict | evidence on main |
|---|---|---|
| F1 | **Stands, amended by D5.** The hold covers both halves of liveness | `executionHeld` (lib/kernel/resolution.js) skips resolvers into a held item in `resolutionMap`. `queue.isLive` reads a held item as live. The seed schema-task/-issue `transitions()` and `setStatusLocal` refuse a completion status on a held node. The amendment: a GIVE-UP status is dead even while held, so the hold never keeps an abandonment inert. |
| F2 | **Stands, strengthened by D10.** | `claimExecutionHold` refuses a live foreign hold (H1/H2). `writeCompletion` is ONE CAS `put_node` carrying the §4.3 409 branch table. The execution store adds a fenced `confirm` before step 1, so a worker that lost the lease cannot write the resolving edge even with a matching revision. |
| F11 | **Stands, amended by D3 and D4.** | The `bundle` reference carries `store`/`key`/`locator`/`sha256`/`bytes`/`commit`, and the producer verifies by fetching into a scratch repository. test/candidate-publish.test.js fetches and verifies from the locator alone after the producer's worktree is gone. Amendments: the default store is machine-local in both modes, a refused SHAPE is `unpublishable` (neither pool), and `branch` also admits `ssh://`. |
| F12 | **Stands, as written.** | `boundaryReached` (lib/kernel/completion.js) reads the pinned `impl_claim.completion.after` against `gates_state`/`integration_state`. `after: integration` with the gates passed and integration running derives nothing. |
| F13 | **Stands, as written.** | There is no `publish: none` (E11 refuses it at parse). `impl_claim.publish` rides the record's creation write, so an unverified reference has one meaning: owed. |
| F14 | **Stands, as written.** | The candidate fold appends a same-tree relabel to `commits_seen` and changes nothing else. The publish is an exclusive create keyed on `candidate_id`. Integration builds its candidate from the pinned commit (task-spor-integration-builds-candidate-from-pinned-commit). |
| F15 | **Stands, amended by D2, D4 and D6.** | Each record has ONE `impl_attempts[]` entry, reserved `pending` and settled once with outcome and pool together (`settleImplAttempt`). Publish tries are `publish_attempts[]` on the candidate. Amendments: `pending` never survives a terminal classification, shape refusals charge nothing, and the retry pool is the shared `gate_progress.pools.retry` counter. |
| F16 | **Stands in substance. Closed by a different mechanism (D7).** | No later fixer can alter what a review accepted without the review seeing it. The mechanism is not a G9 re-judge step: any head move restarts the pipeline from gate 0, and a review stands only at the head it approved. The command-gate opt-out retains a pass only on a verified ancestor, and says so in the signed attestation. |
| F17 | **Stands, amended by D8.** | `candidate-mismatch` settles `mismatch` and files ONE `requires: [human]` item (`task-impl-mismatch-…`) that `blocks` the item, with the hold kept and neither pool charged. An integration-time mismatch is recorded on `integration_state`, not on `impl_state`. |

### 11.3 Divergence ledger

Each row reads: what the text above said, what shipped, and which is
canonical. In every row the shipped side is canonical.

| id | topic | design said | shipped (canonical) |
|---|---|---|---|
| D1 | completion resolver | §3.5/§4.3/§4.5/§6.1: the implementer's resolver, holding no edge, gains `resolves` at completion, and a retyped edge is restored | the implementer's resolver carries `relates-to` and is named by a `CANDIDATE:` first report line. The controller writes its own `art-completion-<stem>-<cand12>` artifact carrying `resolves`. A retyped edge stays `relates-to`. |
| D2 | `pending` | §4.1 left "not yet classified" open-ended (at revision 691ad9d: unknown outcomes stay pending) | `pending` is a reservation only. A terminal run is always classified, and an unrecognized terminal reading is `failed` (code pool). Only the STAGE state resumes on an unknown word. |
| D3 | `bundle_store` default | §2.1: `file://<SPOR_HOME>/candidates` locally, the server's door remotely; gitignored beside `/journal/` | `file://<userConfigHome>/candidates` in both modes. The `.gitignore` line is written where the store resolves. The hosted door is reached only when declared. |
| D4 | refused reference shape | §3.4: a failed publish, retried from the workspace under `retry` (I3a) | `unpublishable`, neither pool. The knowable shapes are refused at startup. Only a genuine outage is `infrastructure`. `branch` also admits `ssh://`. |
| D5 | held item with a give-up status | §4.5: live under any status | live under a completion status, dead under a give-up status. The reconciler owes `withdraw` for a hold or an edge on a given-up item. |
| D6 | classifier vocabulary and pools | §5.3: one table from run observation to attempt outcome | two layers: dispatch (`completed/failed/infrastructure/cancelled/declined/unroutable`), then product (`judgeProduct`), plus a separate publish classification. The retry pool is `gate_progress.pools.retry`, per pipeline attempt. Both caps are 0 when no stage is declared. |
| D7 | the tip rule and the dispatch bound | preamble fact 2, §3.3, G9-G11, §5.4: fix cycles re-run only the failed gate, and a separate G9 re-judge step runs at acceptance | commit-bound attestation: a head move restarts from gate 0, passes at the current head stand, and caps are cumulative, so the bound is the sum of the caps. `rejudge_on_repin: false` retains a verified-ancestor pass. |
| D8 | where `mismatch` lives | M1 settles `impl_state: mismatch` at any stage | the stage's `mismatch` comes from its own decision. An integration mismatch is `integration_state: mismatch`. |
| D9 | runner refinements | I2, I10, I12, §6.5 (a) | a refused re-dispatch withdraws its reservation. An unfollowable attempt is `cancelled`, then escalated. A stamp that does not land escalates on a live worker. The retry order is charge, reserve, wait. `--regate` opens a new ledger segment. `interrupted` (I12) is reserved for a STOP; an empty segment with none requested escalates instead of resuming as a re-offerable park (task-spor-work-loop-parked-reoffer-cap, landed after this reconciliation's baseline — see §11.5). |
| D10 | ownership at completion | §4.3, §6.5 (c): the CAS plus the hold | also the execution store's fenced `confirm` (flush the outbox, renew) before step 1. `impl_claim` gains the store fields. |
| D11 | the hosted contract | §7.1-§7.5 | EXECUTION-STATE.md / lib/kernel/execution.js: the coarse stage enum, the pools `implementation/retry/cycle/rescue`, twelve event types (no retraction or withdrawal events), gate keys without `candidate_id`, NUL-joined execution ids, and `409 execution_boundary`. |

### 11.4 The two design issues this reconciliation gates

- **issue-spor-implementation-design-retry-default** (the default table said
  30000 ms while the parser defaults to 60000 ms, at revision 691ad9d). This
  does not apply to the reconciled text. The saved design (e18e2c9) already
  reads `60000` in the §2.1 example and the default table, which matches
  `GATE_DEFAULTS.implementationRetryBackoffMs` and the WORKERS.md §10.14
  example. No 30-second value appears anywhere in the document. Revision
  691ad9d is not in this repository's history.
- **issue-spor-implementation-design-unknown-terminal-outcome** (the design
  said unknown outcomes remain pending). This is closed by D2. The §4.1 note
  reserves `pending` for active or unobservable runs and makes the
  classifier's `failed` authoritative for an unrecognized terminal reading.
  That matches `classifyExecutionOutcome` rule 1 and `implAttemptDecision`'s
  unknown-word branch. §5.3's "ambiguity classifies as `failed`" rule was
  already in the saved text.

### 11.5 Independent review of the reconciliation

A fresh-context reviewer with no part in writing this text checked it against
the code on `main` at ad94f9d (medium effort, correctness only). It verified
every factual claim in the Reconciled notes and in §11.2-§11.4, including the
classifier order, the pool maps and caps, the parser defaults, the store
default and the `ssh://` normalization, the completion resolver id and the
`CANDIDATE:` form, the give-up exception in `isLive`, the execution kernel's
vocabularies and key formats, each runner refinement in D9, and the
`impl_claim` store fields. It found no contradiction in the original text
that is left uncovered by a D-note. It raised one should-fix: the D11 key
format for `candidate.published` was stated imprecisely. That is corrected
above. No blocking findings.

Landing this text on `main` (this reconciliation's own merge) found one more:
`main` had advanced past ad94f9d to include
task-spor-work-loop-parked-reoffer-cap, which narrows I12's `interrupted` to a
STOP and settles an empty ledger segment `escalated` instead — a small,
mechanical gap the fresh-context review above did not see because it ran
before that commit landed. Folded into D9 and the Reconciled-rows list above
rather than re-running the review, since the fix is additive (a missed
refinement, not a wrong one) and re-verified directly against
`lib/shell/implementation-stage.js` on the code this lands beside.
