# Emitting the factory

Everything here is a **data** write through the validated door: `spor put-node`
in a shell, `put_node`/`add_edge` from Cowork or the connector. One command, one
node; the CLI resolves local vs remote and your identity on its own.

Emit in dependency order so nothing dangles:

```
schemas → profiles → gate nodes → factory → test-writer lane
```

## 0. Adopt the schemas

`factory` and `gate` ship in the **candidate** pack, not the seed — a factory
changes what a worker will accept, so it arrives by deliberate adoption, never
active-everywhere-instantly:

```bash
spor schema candidates                      # adoption state of each
spor schema adopt schema-factory
spor schema adopt schema-gate
```

Adoption lands `status: proposed`. On a **personal/local** graph add
`--activate`. On a **team** graph a *different* identity activates it (no
self-approval) — say so and name the person; until then the types are declared
but not registered, and `spor validate` will warn `unknown type 'factory'`.

## 1. Profiles

A profile is the lane a gate routes to — the reusable runtime bundle, "the
HOW". Emit one only if none exists (`spor query --type profile --summary`).
**Every** lane the factory will name goes here, the `test_lane_profile`
included: the factory references it by id, so it has to exist before the
factory is written, even though the queue item it serves comes last (step 4).

```markdown
---
id: profile-codex-review
type: profile
repo: <slug>
title: Cross-model adversarial reviewer
summary: <one standalone sentence>
date: <YYYY-MM-DD>
harness: codex
model: <model-id>
status: active
---

What this lane is for and why it is a different model from the implementer.
```

**Never** write `command`, `args`, `argv`, `bin`, `exec`, `entrypoint`, `env`,
`report`, `session`, `launch_mode` or `identity_mode` on a profile — `spor
dispatch` refuses a profile carrying any of them, because a graph write must
never define what a machine executes. A harness with no in-code adapter is
still just a name here; the operator binds it in their own machine config
(`dispatch.harness.<id>`), which you do not write.

Check satisfiability before you promise anything: `spor capabilities` says what
this box can launch. A gate routed to an unsatisfiable profile fails every time
it runs.

## 2. Gate nodes (only for gates worth sharing)

A `type: gate` node is one gate standing on its own, so more than one factory
can reference it — org governance vets a `gate-security-review` once. A one-off
gate belongs inline in the factory; the runner unwraps a reference into exactly
the object an inline gate would have been, and keys written beside the `ref`
override the referenced gate's own.

````markdown
---
id: gate-adversarial-review
type: gate
repo: <slug>
title: Adversarial cross-model review
summary: <one standalone sentence — most consumers only ever see this>
date: <YYYY-MM-DD>
status: active
edges:
  - {type: relates-to, to: profile-codex-review}
---

Why this gate exists, in the operator's own words, and what it does not catch.

```json
{
  "id": "adversarial-review",
  "kind": "agent-review",
  "profile": "profile-codex-review",
  "cycles": 2,
  "instructions": "Hunt for correctness defects and silent data loss; ignore style."
}
```
````

Keys by kind (`lib/kernel/gates.js` is the authority):

- **command** — `command` (required), `timeout_ms` (default 900000), `dir`.
  Deliberately *no* ref or protected-path key: those belong to the factory, so
  one shared gate can never relax another team's trusted boundary.
- **agent-review** — `profile` (required), `instructions`, `await_ms` (default
  3600000). Must be a **supervised** harness: the report is the verdict channel.
- **human** — `risk` (the factory-declared classes that arm it; empty means
  always), `approval_timeout_ms` (default 24h), `poll_ms`, `instructions`.
- all three — `cycles` (default 0), `title`, `id` (kebab-case, under 48 chars).

## 3. The factory

````markdown
---
id: factory-<team-or-product>
type: factory
repo: <slug>
title: <what "done" means here>
summary: <one standalone sentence>
date: <YYYY-MM-DD>
status: active
edges:
  - {type: relates-to, to: gate-adversarial-review}
  - {type: relates-to, to: profile-test-writer}
---

What this factory refuses and why, in the operator's own words — the acceptance
criteria they gave you, verbatim enough that a later reader can tell whether a
gate still serves them.

```json
{
  "factory": "<team-or-product>",
  "trusted_ref": "main",
  "repos": ["<slug>"],
  "protected_paths": ["test/**"],
  "test_lane_profile": "profile-test-writer",
  "risk_classes": { "touches:payments": ["lib/billing/**", "**/payments/**"] },
  "gates": [
    {"id": "acceptance", "kind": "command", "command": "npm test", "timeout_ms": 900000},
    {"ref": "gate-adversarial-review", "cycles": 2},
    {"id": "payments-approval", "kind": "human", "risk": ["touches:payments"]}
  ]
}
```
````

`gates` is **ordered** — the runner walks it in order and stops at the first
refusal, so put the cheap deterministic check first and the person last.

`repos` is **the repos this factory may judge** — write it, and never assume
the worker's `--project` will bound it: a bare repo slug on the queue resolves
UP to its home-project grouping and unions the members, so a sibling repo's
items reach a gated worker and its command gate runs against a checkout it was
never authored for (issue-spor-work-scope-union-factory-mismatch). Usually it
is the one repo you compiled the factory in, and the factory node's own
`repo:` stamp is the fallback when you omit it (the legacy `project:` spelling
still reads the same, but emit `repo:` — it is the current stamp key,
dec-cc-repo-project-two-layer-identity) — so this is a key
to write when the factory genuinely covers several repos, or when you want the
scope stated rather than inherited. An item outside the scope is skipped
visibly by the worker, never gated. Do not emit `"repos": []` — an empty list
is an error, not "judge anything".

Six things a factory must satisfy or it refuses to start the worker:

1. every `ref` resolves to a `type: gate` node that exists;
2. every agent-review gate names a `profile`, and command gates a `command`;
3. `protected_paths` without a `test_lane_profile` is an error — "fails closed"
   must never mean "dropped on the floor";
4. a human gate may only name risk classes declared in `risk_classes` — a gate
   that can never arm reads exactly like an approved one;
5. gate ids are unique and kebab-case;
6. `repos`, if written, names at least one repo.

## 3b. The integration block — merge-queue landing (optional)

Only emit this if the operator asked for automatic landing (interview
question 7). Absent is not a lesser factory — it is today's default,
resolve-without-merge, unchanged. It is **not a gate**: it runs once, last,
after every declared gate has passed, and it is the one part of this payload
that mutates `target_ref` rather than just judging a branch — so state that
plainly before you write it.

It lives beside `gates` in the same factory JSON payload, never as its own
node:

```json
{
  "factory": "<team-or-product>",
  "trusted_ref": "main",
  "gates": [ "..." ],
  "integration": {
    "target_ref": "main",
    "mode": "local",
    "command": "npm test",
    "strategy": "merge",
    "serialize": "repo",
    "cycles": 1
  }
}
```

Keys (`lib/kernel/gates.js parseIntegration` is the authority):

- **`target_ref`** — what "landed" means; defaults to the factory's own
  `trusted_ref`, so state that default rather than always writing it.
- **`mode`** — `local` (CAS a local ref with `git update-ref`), `push` (push
  to a remote, whose own non-fast-forward rejection *is* the
  compare-and-swap), or `propose` (open a pull request via the `gh` CLI from
  the gate-passed branch and park the item for review, rather than mutating
  `target_ref` directly — for orgs whose policy forbids a worker pushing
  straight onto the target ref). The candidate suite still runs pre-PR under
  `propose`, so a PR only ever opens known-green. `propose` needs the `gh`
  CLI on PATH on every box that runs `spor work` — the worker refuses to
  start otherwise, so ask the operator to confirm it is installed
  (https://cli.github.com) before emitting it.
- **`command`** (required) — the FULL suite, run again on the merged
  candidate tree, never a fast subset deferred to CI after landing. Reuse the
  same command interview question 1 already settled unless they name a
  different one.
- **`strategy`** — `merge` | `squash` | `rebase` (default `merge`) — how the
  candidate tree is built from `target_ref` + the branch.
- **`serialize`** — must be `"repo"`, the only declared lease scope. Do not
  ask the operator about this; just write it (or omit it — it is the default).
- **`cycles`** (default 0) — fix cycles on a merge conflict or a
  candidate-suite failure, fed through the same fix-cycle machinery a failing
  gate uses. This is a separate counter from any gate's own `cycles`.
- **`timeout_ms`** (default 900000) — the candidate suite's timeout.

State back to the operator, in one line each: it re-runs the full suite a
second time on the merged result (so a green gate run does not skip it), a
conflict or that re-run failing is a fix-cycle event exactly like a failed
gate — not a silent drop — and every landing or failure writes an `art-merge-`
fact, the integration stage's twin of a gate's `art-gate-` fact
(WORKERS.md §10.9, `references/maintenance.md`).

## 3c. Gates that need a service — a database, a stack, a login (optional)

A command gate runs in a throwaway worktree the runner cuts from the
implementer's commit. Everything the suite needs that is not in git — a
`node_modules`, a local database, credentials — is staged by the repo's own
hooks, declared in the repo's committable `.spor.json`, never in the factory:

```json
{ "dispatch": { "worktree": true,
                "worktreeSetup": "scripts/spor-tree-setup.sh",
                "worktreeTeardown": "scripts/spor-tree-teardown.sh" } }
```

Both hooks run with cwd = the tree and `SPOR_WORKTREE`, `SPOR_MAIN_CHECKOUT`,
`SPOR_DISPATCH_SLUG`, `SPOR_DISPATCH_NODE`, and **`SPOR_TREE_ROLE`** =
`dispatch` (the implementer's worktree) | `gate` (a command gate's tree) |
`integration` (the merge candidate). Teardown runs before each tree is
removed. A Supabase-shaped pair, for a suite that needs `supabase start`:

```sh
# scripts/spor-tree-setup.sh
ln -s "$SPOR_MAIN_CHECKOUT/node_modules" node_modules
case "$SPOR_TREE_ROLE" in gate|integration) supabase start ;; esac   # only where the suite runs
# scripts/spor-tree-teardown.sh
case "$SPOR_TREE_ROLE" in gate|integration) supabase stop --no-backup ;; esac
```

Then the gate itself carries the two fields such a suite needs:

```json
{"id": "rls", "kind": "command", "command": "bash scripts/rls-gate.sh",
 "timeout_ms": 2400000, "serialize": "repo", "risk": ["touches:db"]}
```

- **`serialize: "repo"`** — the suite owns a singleton per box (a fixed port,
  a fixed container name, a `db reset`); the gate waits for any other run of
  a serialized gate, or the integration stage, on the same repo before it
  starts. The same lease `integration.serialize` uses.
- **`risk`** — the classes (from `risk_classes`) that ARM this gate, exactly
  as on a human gate. Unarmed, the gate records `skipped` and runs nothing;
  an unreadable diff still fails closed.
- The suite's env carries **`SPOR_GATE_BASE`**, **`SPOR_GATE_HEAD`** (the shas
  under judgement), **`SPOR_TRUSTED_REF`**, **`SPOR_GATE_STAGE`** (`gate` |
  `integration`) and **`SPOR_GATE_NODE`**, beside `CI=1` and `SPOR_GATE=<id>`,
  so a script can `git diff --name-only $SPOR_GATE_BASE..$SPOR_GATE_HEAD` and
  decide for itself, the way a CI job reads a pull request's file list.

State back: which box has the service (that box is the worker), that the
gate queues, that it is skipped and says so when the change never touched the
database, and that the hook pair is engineering's to write and commit.

## 4. The test-writer lane

When step 2 of the creation flow found no acceptance suite, the operator's
answers *are* the spec for one. Its lane profile was emitted in step 1; what is
left is one queue item whose body carries their criteria in their words:

```markdown
---
id: task-<stem>-acceptance-suite
type: task
repo: <slug>
title: Write the acceptance suite for <what>
summary: <one standalone sentence naming what the suite must cover>
date: <YYYY-MM-DD>
profile: profile-test-writer
edges:
  - {type: relates-to, to: factory-<team-or-product>}
---

## Acceptance criteria (the owner's words)

1. "<criterion, verbatim>"
2. "<criterion, verbatim>"

## Journey to cover

<the steps they walked you through>

Black-box only: drive the product the way a customer does. The suite is the
judge, so it lives under the factory's protected paths and is written by this
lane, never by the lane that writes the code under test.
```

Then stamp it agent-ready with provenance rather than hand-writing the fields:

```bash
spor ready task-<stem>-acceptance-suite
```

Wire the order if the factory is meant to gate on that suite: the suite item
`blocks` nothing by itself, but say plainly that the command gate should be
added **after** the lane lands — a gate pointing at a command that does not
exist yet fails every gated item.

## 5. Validate what you wrote

```bash
spor validate                     # local graph lint — exit 1 on errors
spor get factory-<id>             # read it back as the graph serves it
spor query --type gate --ids      # every ref resolves
```

A remote graph validates per write, so a rejected `put-node` is the lint. Read
the error rather than retrying: a 422 on a factory is almost always a body over
8192 bytes (trim the prose, not the payload) or a summary over 500 characters.

`spor validate` only checks that the body has a fenced `json` payload — it does
not parse `gates` or `integration` the way the runner does. `spor work
--factory factory-<id> --print` does: it loads and validates the definition
the same way the real loop would, prints the resolved pipeline, and dispatches
nothing — so a bad `integration:` block surfaces there as a load error before
anyone hands the factory off, and (for `mode: propose`) a missing `gh` on
PATH surfaces as a refusal to start rather than a silent no-op.

## Writing from Cowork or the connector

Same nodes, no shell: `put_node` with the full markdown, `add_edge` for the
edges, `schema` to check the candidate types are registered. Everything else in
this file is unchanged — the shapes are the contract, not the door.
