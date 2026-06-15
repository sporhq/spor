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

## Mode — resolve it silently, never announce it

You already know your mode: the Spor status line injected at session start says
either `team graph: …` (remote — a `SPOR_SERVER` is set) or `A Spor knowledge
graph is active: …` (local). Use that; if it isn't in context, test
`[ -n "$SPOR_SERVER" ]` once. Either way, do **not** echo
`SPOR_SERVER`/`SPOR_TOKEN`/`SPOR_HOME`, and do **not** tell the user which mode
is running unless they ask — it's plumbing they don't need. Run the commands
below quietly (no `echo` of `$SPOR_ROOT` or the slug).

## Remote mode (team graph) — when `SPOR_SERVER` is set

(Env vars here are the `SPOR_*` family; the legacy `SUBSTRATE_*` names are
still read.)

```bash
TOP=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
# a committed .spor marker (repo: <slug>, legacy project:) beats basename inference
SLUG=$(sed -nE 's/^repo:[ \t]*([a-z0-9][a-z0-9-]*)[ \t]*$/\1/p' "$TOP/.spor" 2>/dev/null | head -1)
[ -n "$SLUG" ] || SLUG=$(sed -nE 's/^project:[ \t]*([a-z0-9][a-z0-9-]*)[ \t]*$/\1/p' "$TOP/.spor" 2>/dev/null | head -1)
[ -n "$SLUG" ] || SLUG=$(basename "$TOP" \
  | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
curl -sS --max-time 6 -H "Authorization: Bearer $SPOR_TOKEN" \
  "${SPOR_SERVER%/}/v1/queue?project=$SLUG&limit=10"
# The queue ?project= filter is the repo slug. org-wide view: drop the filter.
# The server resolves slug aliases (repo nodes, GRAPH.md "Repo and project
# identity"), so renamed repos still see their history.
```

In Cowork, call the `my_queue` MCP tool with the same fields.

## Local mode (personal graph) — `SPOR_SERVER` unset

`${CLAUDE_PLUGIN_ROOT}` is empty in the Bash tool, so first resolve the
plugin root from the path the session-start hook cached
(issue-cc-skill-plugin-root-unsubstituted):

```bash
SPOR_ROOT="$(cat "${SPOR_HOME:-$HOME/.spor}/cache/plugin-root" 2>/dev/null \
  || cat "$HOME/.substrate/cache/plugin-root" 2>/dev/null)"
SPOR_ROOT="${SPOR_ROOT:-$CLAUDE_PLUGIN_ROOT}"
node "$SPOR_ROOT/lib/queue.js" --json      # or --project <slug>, --limit <n>
```

Use `--json` and compose the human view from it — don't show the bare CLI
listing, whose leading `[<score>]` is an internal ranking number, not something
to surface (see Presenting).

(No server means no activity feed, so heat is 0 locally; the other signals
are identical.)

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
   (/spor:brief `<item-id>`, or locally with `$SPOR_ROOT` resolved as above:
   `node "$SPOR_ROOT/lib/compile.js" --root <item-id>`) and begin
   from that briefing.
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
3. **`capture-pending` item** → read it (`GET /v1/nodes/<id>`), decide what
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
