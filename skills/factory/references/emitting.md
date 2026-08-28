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
project: <slug>
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
project: <slug>
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
project: <slug>
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

Five things a factory must satisfy or it refuses to start the worker:

1. every `ref` resolves to a `type: gate` node that exists;
2. every agent-review gate names a `profile`, and command gates a `command`;
3. `protected_paths` without a `test_lane_profile` is an error — "fails closed"
   must never mean "dropped on the floor";
4. a human gate may only name risk classes declared in `risk_classes` — a gate
   that can never arm reads exactly like an approved one;
5. gate ids are unique and kebab-case.

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
- **`mode`** — `local` (CAS a local ref with `git update-ref`) or `push`
  (push to a remote, whose own non-fast-forward rejection *is* the
  compare-and-swap). **Never emit `mode: propose`** — it parses but is refused
  at load time in v1 (a factory declaring it gets a load-time error, not a
  silent no-op); if the operator wants a PR-based flow, say it is coming and
  leave `integration:` out for now, or ask whether `local`/`push` plus a
  `human` gate earlier in `gates` covers what they actually want.
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

## 4. The test-writer lane

When step 2 of the creation flow found no acceptance suite, the operator's
answers *are* the spec for one. Its lane profile was emitted in step 1; what is
left is one queue item whose body carries their criteria in their words:

```markdown
---
id: task-<stem>-acceptance-suite
type: task
project: <slug>
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
nothing — so a bad `integration:` block (`mode: propose` included) surfaces
there as a load error before anyone hands the factory off.

## Writing from Cowork or the connector

Same nodes, no shell: `put_node` with the full markdown, `add_edge` for the
edges, `schema` to check the candidate types are registered. Everything else in
this file is unchanged — the shapes are the contract, not the door.
