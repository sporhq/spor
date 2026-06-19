---
name: next
description: Present the Spor decision queue — what to work on next, ranked by graph signals (what each item blocks, neighborhood activity, age, staleness) alongside human-set priority. Use when the user asks "what should I work on", "what's next", "show the queue / backlog", or wants to triage deferred work and pending captures.
---

# What should I work on next?

The queue is computed from the graph, not kept as a list (QUEUE.md §4/§5):
queueable live nodes (deferred tasks, open issues and incidents,
unprocessed captures, org-defined types) ranked by an advisory blend — what they block, recent activity in
their neighborhood, age — plus any human-set `priority:`. High staleness
(anchors superseded or gone) flips the suggestion to **close**, not do.

## Get the queue

Run one command — `spor next` resolves everything (local vs team graph, this
repo's project scope, your identity) on its own:

```bash
spor next --json
```

Use `--json` and compose the human view from it — don't show the bare CLI
listing, whose leading `[<score>]` is an internal ranking number, not something
to surface (see Presenting). Don't echo `SPOR_SERVER`/`SPOR_TOKEN`/`SPOR_HOME`
or announce which mode is running unless the user asks — it's plumbing; if you
ever need to confirm the resolved mode/scope, `spor status` reports it.

**In Cowork (no shell)**, call the `my_queue` MCP tool instead, with the same
fields (`project`, `types`, `exclude_types` arrays, `limit`/`offset`).

**Scope and filter flags** (task-cc-queue-filtering-enhancements). The queue
defaults to this repo's project; three optional, composable levers widen or
narrow it. Reach for them when the user asks for a wider/narrower view ("what's
next across everything", "show me beta's queue", "just the open issues, ignore
pending captures"):

- **Cross-project firehose** — `spor next --all-projects --json` ranks every
  repo's queue at once.
- **A different project** — `spor next --project <token> --json`. The token is a
  repo slug (→ its home-project grouping union), a `repo-<slug>` node id (→ one
  repo), or a `proj-<slug>` grouping id (→ the grouping). The server/CLI resolves
  slug aliases, so renamed repos still see their history.
- **Node-type allow/deny** — `spor next --type task,issue --json` keeps only
  those types; `spor next --exclude-type capture-pending --json` drops them
  (comma-separated, repeatable, exclude wins on overlap). They apply *before*
  ranking, so the aggregate counts describe the filtered queue.

The `my_queue` MCP tool takes the same as fields.

## In-flight awareness — don't re-pick work an agent is already on (Claude Code only)

`spor dispatch` launches Claude Code background agents named after the node id
they work (art-res-task-spor-cli-dispatch-background-agents). Before you
recommend an item, cross-reference live agent state so you don't surface work
that's already in flight — otherwise whoever triages the queue picks up or
re-dispatches a task an agent is already doing.

**`spor next --json` does this cross-reference for you**
(task-spor-cli-in-flight-surface): it stamps each item with an `in_flight`
boolean — and a `dispatched` summary (`{id, name, state, status, cwd}`) on the
in-flight ones — by matching live background agents to node ids. Add
`--hide-dispatched` to drop the in-flight items entirely (it reports a
`hidden_dispatched` count, never silently). This is best-effort and
Claude-Code-only: the `my_queue` / server queue can't see local background
agents, so the flag fails soft (every item reads `in_flight:false`) when the
`claude` binary is absent (e.g. in Cowork or a plain shell).

Prefer reading that flag over shelling out yourself. When you only have the raw
`my_queue` output (which doesn't carry the flag), an item is **in flight** when
a `kind: "background"` agent from `claude agents --json` has `name` equal to the
item's id and `state` is not `"done"`. For those items: badge them "🤖 agent
dispatched — in progress" and keep them OUT of the top "pick this next"
recommendation (the work is already moving; surfacing it invites duplication).
Mention them so the human can still choose to look — counted, never silently
dropped, the same discipline the queue uses for mutes and leases. Items with no
matching live agent are presented normally.

## Presenting and acting

Present in plain language — you are talking to a human who may be new to Spor.
Lead with the top one or two items to pick up and a short, plain reason each is
there ("the oldest still-open piece of work", "it blocks three other tasks",
"nothing's touched it in months"). **Translate** the signals behind each `why`
line into ordinary words; do **not** surface the raw `score` or internal
coinages — *open front*, *heat*, *staleness*, *front* are ranking internals, not
terms a newcomer knows. Honor `suggest: close` by framing the item as likely
done/abandonable rather than work to start. The ranking is advisory; the human
picks. If the result carries `muted` or `dormant` counts, mention them in
passing (hidden by the viewer's `queue_mute` / parked by a `wake:` date — never
silently dropped). Don't open with a glossary or re-explain Spor on every run —
one plain sentence of "why this is first" is enough. Then:

1. **Item picked to DO** → start pre-briefed: run a full root compile for it
   (/spor:brief `<item-id>`, or `spor brief <item-id>`) and begin from that
   briefing.
2. **Item picked to CLOSE** (or `suggest: close` confirmed) → for a `task`
   (`done`) or `issue` (`resolved`), the completion-resolver gate requires a
   durable why ON THE GRAPH first: write a `decision` (the why, for a
   substantive close) or a brief `artifact` (a few lines of what was done, like
   a commit message, for a trivial one) carrying a `resolves` edge to the item,
   THEN flip `status:` with `set_status`. A bare flip with no
   `decision`/`artifact` resolver is denied at the door
   (task-cc-terminal-status-requires-resolver). `abandoned` (task) is exempt —
   won't-do work records nothing, so a plain `set_status` is fine. (Locally,
   write the resolver node file and add the edge, then edit the status.)
3. **`capture-pending` item** → read it (`spor get <id>`), decide what
   it should have been, write the proper node(s), then close the pending node
   with `set_status`: `merged` when its content now lives in the node(s) you
   wrote, or `rejected` when there was no durable fact. Those are the only two
   terminal statuses the schema's `transitions()` gate accepts — `dismissed`/
   `resolved`/`closed` are rejected at write time because they are not terminal
   to the queue and leave the capture ranking live
   (dec-cc-status-enforcement-via-transitions).
4. **Item with nothing actionable until a date** (waiting on a measurement
   window, a renewal, an external milestone) → set `wake: YYYY-MM-DD` on the
   node (`put_node`; locally edit the file). The queue parks it as `dormant`
   and resurfaces it to everyone on that date (QUEUE.md §4). Prefer this
   over a personal `queue_mute` whenever the dormancy is a fact about the
   work rather than a viewer preference.
