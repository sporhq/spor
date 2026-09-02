---
name: factory
description: Compile a team's bespoke software factory into Spor graph data — interview the operator, read the repo and the graph, propose an ordered gate pipeline, then emit the factory definition, its gates, and the profiles they route to as nodes that `spor work --factory` enforces. Use when someone wants to stand up or change what must be true before agent work counts as done ("set up a factory", "what should never break for my users", "add a review gate", "require my approval for auth changes", "make the workers run my tests", "seed an acceptance suite"), or to maintain one from its own gate telemetry ("why did the last three fail review", "the reviews are too strict"). Authors DATA only — it never runs a gate, merges, or claims work.
---

# Compile a factory

A **factory** is what a team means by "done here": the ordered gates a piece of
work must clear between an agent claiming it and it counting as finished. In
Spor a factory is **graph data** — a `type: factory` node — and the worker
process enforces it in code (`spor work --factory <id>`, WORKERS.md §10). This
skill is the **compiler**: it interviews the operator, reads what already
exists, proposes a pipeline, and emits the nodes. Nothing more.

**The line this skill does not cross:** it only ever authors data — nodes,
edges, profiles. It never runs a gate, never runs a suite, never dispatches a
review, never merges, never claims or resolves work, and never writes
machine-local config. The runner does all of that; a gate that were "an
instruction to an agent" is not a gate at all, it is a suggestion with a
plausible transcript (dec-spor-software-factory-substrate). Two corollaries
bind every write below:

- **A graph write must never define what a machine executes.** Profiles carry
  a harness *name*, never a command, argv, env, bin, entrypoint, report or
  session key — `spor dispatch` refuses a profile that carries one. If the
  operator wants a custom harness, they declare what it runs in their own
  machine config (`dispatch.harness.<id>`); you write only the id.
- **You never turn the factory on.** Emitting the nodes changes nothing until
  a person runs `spor work --factory <id>` or sets `work.factory`. Say so, and
  hand them the command.

Load `/spor:spor` first if you have not this session — it carries the node/edge
format and the CLI surface every write below uses.

## Which flow

Start by finding out whether a factory already exists:

```bash
spor query --type factory --summary      # declared factories
spor query --type gate --summary         # shareable gates the org has vetted
```

- **Nothing there** → the **creation flow** below.
- **Something there, and the ask is about it** ("why did the last three fail
  review", "reviews are too strict", "add a gate") → the **maintenance flow**:
  `references/maintenance.md`.

## Creation flow

Five steps, in order. Steps 2 and 3 come **before** you propose anything: never
ask an operator a question the repo or the graph already answers.

### 1. Interview — in the operator's register

Read the room first. A **non-technical owner** ("I want my agents to stop
breaking checkout") gets product questions; an **engineer** ("I want a codex
review gate with two fix cycles") gets pipeline questions and denser proposals.
The underlying questions are the same seven — including whether gate-passed
work should land itself, the `integration:` block — only the language changes.

The acceptance-criteria interview is the non-technical operator's whole factory
job made first-class: **human judgment defines what correct looks like**, and
"what should never break for your users" is exactly a black-box acceptance
spec, stated before the code exists. Turning those answers into a runnable
suite is a lane you seed (step 5), not something you ask them to write.

The question banks, the register tells, and the translation table from a
product answer to a gate are in **`references/interview.md`**. Ask a few
questions at a time and reflect answers back — never a wall of them.

### 2. Read the repo

Look, then ask about what you could not find:

```bash
ls .github/workflows .gitlab-ci.yml Makefile 2>/dev/null   # what CI already runs
sed -n '1,60p' package.json                                # test/lint scripts
ls test tests spec e2e 2>/dev/null                         # is there an acceptance suite at all
sed -n '1,80p' CLAUDE.md AGENTS.md 2>/dev/null             # the repo's own hard rules
git branch --show-current && git remote show origin 2>/dev/null | sed -n '/HEAD branch/p'
```

What you are extracting: the **command** a command gate should run (prefer what
CI already runs — a gate that disagrees with CI is a second definition of
done), the **trusted ref** (the repo's default branch), the **protected test
paths**, any hard rule from CLAUDE.md/AGENTS.md that is really a gate in
prose ("refactors prove themselves byte-identical", "zero dependencies") —
and **what the suite needs that is not in git**: a `services:` block in CI, a
`docker compose`, `supabase start`, a `DATABASE_URL`, an `engines` pin. Each
of those is a hook the repo must carry and, for a one-per-box service, a
`serialize`/`risk` pair on the gate (`references/emitting.md` §3c); the box
that has the service is the only box that can be the worker.

### 3. Read the graph and the fleet

```bash
spor query --type norm --summary          # standing rules a gate may already encode
spor query --type profile --summary       # review/implementer/test lanes that exist
spor capabilities                         # what THIS machine can actually satisfy
```

Reuse before you mint: an existing `profile-codex-review` is better than a new
one, and a vetted `gate-*` node is better than an inline copy. If a profile you
want to route to names a harness this machine cannot satisfy, say so in the
proposal — the operator can declare it, but a routed gate that no box can
launch fails every time it runs.

### 4. Propose the pipeline back, and wait

Echo an ordered pipeline in the operator's own register, one line per gate:
what it checks, what it refuses, and what it costs (a suite run, a review
dispatch, a person's attention). Name what you could not find and what you
assumed. Then **stop and get confirmation** — you are about to write durable
graph data that changes what a worker accepts.

Say plainly what each kind cannot do:

- a **command** gate only knows what the suite knows;
- an **agent-review** gate is a second opinion, not a proof — and it must route
  to a *supervised* harness, because its report is the verdict channel;
- a **human** gate is the only one that can say "I don't like this", and it
  costs the person's time on every armed change.

If they want an `integration:` block too, say what it is not: not a fourth
gate, but a merge-queue stage that runs once, last, after every gate passes —
it mutates `target_ref`, re-runs the full suite on the merged result, and a
conflict or that re-run failing is a fix-cycle event like any other gate.
Offer `local` or `push`, or — for orgs whose policy forbids a worker pushing
straight onto the target ref — `propose`: the candidate suite still runs
pre-PR, but landing means opening a pull request (via `gh`) from the
gate-passed branch and parking the item for review rather than mutating
`target_ref` directly; `propose` needs the `gh` CLI on PATH on every box that
runs `spor work` (a preflight refuses to start otherwise). Leaving
`integration:` out entirely keeps resolve-without-merge working as it does
today.

### 5. Emit the nodes

In this order, so nothing dangles: **schemas → profiles → gates → factory →
test-writer lane**. Every template, the adoption step, and the validation pass
are in **`references/emitting.md`**. In short:

```bash
spor schema adopt schema-factory     # + schema-gate; --activate on a personal graph
spor put-node - --if-exists skip <<'EOF'
...the node markdown...
EOF
spor validate                        # local graph: lint what you wrote
```

Then check your own work against the runner's rules before handing off — a
factory that does not validate **refuses to start the worker**, which is the
right failure but a rude way to discover a typo:

- every `{"ref": "gate-…"}` points at a `type: gate` node that exists;
- every agent-review gate has a `profile` (the runner checks the field is
  present, not that a matching profile node exists — a typo there is not
  caught until dispatch, so double-check it yourself, e.g. `spor get <profile>`);
- `protected_paths` is declared **only** with a `test_lane_profile` to route to;
- every risk class a human gate names is declared in `risk_classes`;
- gate ids are unique and kebab-case;
- if you wrote an `integration:` block: `mode` is `local`, `push`, or
  `propose`, `command` is set, `strategy` is one of `merge`/`squash`/`rebase`,
  and `serialize` is `repo` — and if `mode` is `propose`, the `gh` CLI must be
  on PATH wherever `spor work` runs, or the worker refuses to start. `spor
  work --factory factory-<id> --print` loads and validates it without
  dispatching anything.

### 5b. Seed the test-writer lane when there is no suite

If step 2 found no acceptance suite, the acceptance criteria from step 1 are
the specification for one that does not exist yet. Emit the **lane profile**
and a **queue item** carrying those criteria as its body, stamped agent-ready:

```bash
spor put-node - --if-exists skip <<'EOF'   # profile-<team>-test-writer, then the task
EOF
spor ready task-<stem>-acceptance-suite
```

This is the same separation the runner enforces at the other end (WORKERS.md
§10.3): the lane that writes the test may not be the lane that writes the code
— same entity, same misunderstanding. Do not point the command gate at a suite
that does not exist yet; declare the gate once the lane has landed it, or the
first gated item fails on a missing command.

### 6. Hand off

Tell them the one command, and that nothing changed until they run it:

```bash
spor work --factory factory-<id>          # or set work.factory in .spor.json
spor work --status                        # what is gating, and why an item was cooled off
```

A bare `spor work` keeps running exactly as before — adoption has no cliff in
either direction.

## Maintenance flow

Every gate outcome is already a graph fact (`art-gate-*`, WORKERS.md §10.6),
and — for a factory with an `integration:` block — every landing or landing
failure is too (`art-merge-*`, WORKERS.md §10.9), so "why did the last three
fail review" or "why isn't finished work landing" is a **query**, not a guess,
and "the reviews are too strict" is a definition edit proposed **with that
evidence attached** — never a silent one. The queries, the read-back, and the
propose-an-edit protocol are in **`references/maintenance.md`**.

## Refusals

Say no, briefly, and offer the nearest thing you can do:

- **"Just make the factory run this script for me"** — a gate's `command` is
  the declared acceptance suite the runner executes from the trusted ref; it is
  not a hook for arbitrary machine work, and a profile may not carry a command
  at all. Offer: declare it in machine config and reference the harness id.
- **"Run the gates now and tell me if it passes"** — that is `spor work`'s job.
  This skill writes the definition; it does not enforce it.
- **"Skip the review for this one"** — a gate exists to be unskippable. Offer
  the honest alternatives: sharpen the gate's `instructions` so it stops
  flagging what they do not care about, **raise** `cycles` so the implementer
  gets another pass before it escalates to them, or retire the gate with a
  decision node saying why. Only a **human** gate has `risk` classes to narrow;
  an agent-review gate has no arming predicate and runs on every gated item.
  And `cycles` is fix cycles *before* escalation — lowering it reaches a person
  sooner, not later.
- **"Set protected_paths so agents can fix the tests when they fail"** —
  that defeats the one property protected paths exist for. Offer the
  test-writer lane instead.

## Verify without an LLM

`skills/factory/fixtures/` is a worked dry run: a sample interview transcript
and the exact node set a correct compilation of it emits. `npm test` runs
`test/factory-skill.test.js` over it — the fixture nodes are loaded into a
scratch graph with the candidate schemas adopted, linted with `spor validate`,
and parsed by the real runner vocabulary (`lib/kernel/gates.js`). Read the
fixture when you want the shape of a finished emission rather than a template.
