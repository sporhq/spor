# Maintaining a factory from its own telemetry

Every gate the runner enforced left a fact behind: one artifact node per gate
per run, `art-gate-<gate>-<stem>-<short-run-id>-…`, carrying `relates-to` the
work item, the verdict, the cycle history and the evidence (WORKERS.md §10.6).
So the maintenance questions are **queries**, and every proposed change to a
factory is argued from nodes you can name.

The rule: **never a silent edit**. A factory is what a team means by done;
changing it without stating what stops being caught is how a gate quietly
becomes decoration.

## Reading what happened

```bash
spor query --type artifact --id-prefix art-gate- --summary       # every gate outcome
spor query --type artifact --id-prefix art-gate-review --summary # one gate's history
spor get art-gate-<...>                                          # the verdict + evidence
spor work --status                                               # what is gating now, and why an item cooled off
spor changes                                                     # recent graph activity around them
```

To go the other way — from a work item to the gates that judged it:

```bash
spor query --edges --edge-type relates-to --to task-<stem>
```

Two more surfaces worth reading before concluding anything:

- the **escalations and approvals** the gates filed. A failed pipeline files a
  `requires: [human]` item that `blocks` the work item (§10.7); those are the
  refusals a person was actually asked to judge:
  `spor query --type task --where requires=human --summary`.
- the **rolled-back items** — a refused claim has its completion status rolled
  back to `open` while its resolving edge stands, which `spor get` flags with a
  ⚠. An item in that state is a refusal nobody has adjudicated yet.

## "Why did the last three fail review?"

1. Pull the last review-gate facts and read the findings out of each — the
   severities, the files, the summaries. Do not summarize from memory; quote.
2. Classify what you see, because the fix differs:
   - **the same real defect three times** — the gate is working. The lesson is
     upstream: an implementer-prompt or norm change, not a factory edit.
   - **findings the reviewer could not have known** (missing repo context,
     conventions it never read) — sharpen the gate's `instructions`, which is
     the cheapest and most reversible edit there is.
   - **cosmetic findings rated blocking** — the reviewer's severity calibration
     is off; put the calibration in `instructions` ("style is not blocking").
   - **unreadable or absent verdicts** — not strictness at all. The gate is
     routed to a lane whose report the runner cannot read; an agent-review gate
     must route to a **supervised** harness. Fix the profile, not the gate.
   - **a suite failure, not a review one** — read the command gate's fact
     instead; a flaky suite reads as a strict factory from the outside.
3. Report the classification with the node ids behind it, then propose.

## "The reviews are too strict"

Answer with evidence, in this order, and prefer the smallest edit the evidence
supports:

1. **Sharpen `instructions`** — say what is in scope and what is not. Cheapest,
   most reversible, and usually the real fix.
2. **Raise `cycles`** — the review is right but the implementer needs another
   pass before escalating to a person.
3. **Narrow a human gate's `risk_classes`** — it is arming on changes nobody
   meant it to cover; tighten the globs.
4. **Retire the gate** — **remove its entry from the factory's `gates` list**;
   that is the half that stops it running. Setting the gate node's `status:
   retired` is bookkeeping for readers — the runner resolves a gate by id and
   never reads its status, so a retired gate still referenced still runs. Never
   delete the node: the facts it wrote point at it.

Whichever you propose, state in one line **what stops being caught**. If the
evidence does not support the change the operator asked for, say so and show
the findings that contradict it — the same discipline as an eval-gated review
loop: change the judge only when the evidence set says the current one is
wrong, not when its verdict was unwelcome.

## Making the edit

Two writes, in this order — the reasoning first, so the factory revision has
something to point at.

1. **The decision**, carrying the evidence: a `type: decision` node whose body
   says what the telemetry showed (node ids, quoted findings), what changed in
   the definition, and what the factory no longer refuses as a result. Edge it
   `relates-to` the factory and `relates-to` each `art-gate-*` fact you argued
   from.

2. **The factory revision**, optimistic-concurrency checked:

```bash
spor get factory-<id> --json          # take the `revision`
spor put-node <edited>.md --if-exists update --revision <sha>
spor validate
```

`--if-exists update` **requires** that revision, so a concurrent edit by
somebody else fails the write instead of silently losing. If it conflicts,
re-read and re-apply — never drop `--revision` to force it through.

Retiring a whole factory is the same shape, with the same caveat: `status:
retired` on the node plus a decision saying why is a marker for **readers**.
The runner loads whatever `--factory` / `work.factory` names and checks only
that it is a `type: factory` node whose payload validates — it never reads the
status. What actually stops the gating is un-pointing the worker (drop the flag
or the config key), after which `spor work` runs bare, ungated, by design. Say
both halves, or an operator retires a factory on the graph and keeps being
gated by it.

## What maintenance never does

- It never retracts a resolving edge or re-closes a rolled-back item. A gate
  refusal is a person's to adjudicate; the resolver node is the agent's durable
  record of what it did.
- It never resolves an escalation or approval item on the operator's behalf —
  approving is precisely the thing a human gate exists to make a person do.
- It never edits machine config to make a gate pass, and never disables a gate
  for one item. There is no per-item bypass by design; the honest moves are the
  four above.
