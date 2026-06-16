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
# A bare repo slug resolves UP to its home-project grouping and unions the
# member repos' queues — the intuitive token returns the whole product
# (dec-spor-queue-slug-resolves-to-grouping). For one repo of a grouped product,
# pass its repo NODE id (?project=repo-<slug>); for the org-wide view, drop the
# filter. The server resolves slug aliases (GRAPH.md "Repo and project
# identity"), so renamed repos still see their history.
```

In Cowork, call the `my_queue` MCP tool with the same fields.

**Scope and filter flags** (task-cc-queue-filtering-enhancements). The queue
defaults to the session's project; three optional, composable levers widen or
narrow it. Reach for them when the user asks for a wider/narrower view ("what's
next across everything", "show me beta's queue", "just the open issues, ignore
pending captures"):

- **Cross-project firehose** — drop `?project=` entirely (`/v1/queue?limit=10`)
  to rank every repo's queue at once. CLI: `spor next --all-projects`.
- **A different project** — `?project=<slug>` (repo slug → grouping union;
  `repo-<slug>` id → one repo; `proj-<slug>` id → the grouping). CLI:
  `spor next --project <slug>`.
- **Node-type allow/deny** — `?type=task,issue` keeps only those types;
  `?exclude_type=capture-pending` drops them (comma-separated, repeatable,
  exclude wins on overlap). They apply *before* ranking, so the aggregate counts
  describe the filtered queue. CLI: `spor next --type task,issue`,
  `spor next --exclude-type capture-pending`.

The `my_queue` MCP tool takes the same as fields: `project`, `types`,
`exclude_types` (arrays), plus `limit`/`offset`.

## Local mode (personal graph) — `SPOR_SERVER` unset

`${CLAUDE_PLUGIN_ROOT}` is empty in the Bash tool, so first resolve the
plugin root from the path the session-start hook cached
(issue-cc-skill-plugin-root-unsubstituted):

```bash
SPOR_ROOT="$(cat "${SPOR_HOME:-$HOME/.spor}/cache/plugin-root" 2>/dev/null \
  || cat "$HOME/.substrate/cache/plugin-root" 2>/dev/null)"
SPOR_ROOT="${SPOR_ROOT:-$CLAUDE_PLUGIN_ROOT}"
node "$SPOR_ROOT/lib/queue.js" --json      # or --project <slug>, --limit <n>
# Same scope/filter flags as remote: --type task,issue / --exclude-type
# capture-pending (whitelist/blacklist node types), and omit --project for the
# cross-project firehose. (`spor next --all-projects` is the CLI shorthand for
# dropping the default scope.)
```

Use `--json` and compose the human view from it — don't show the bare CLI
listing, whose leading `[<score>]` is an internal ranking number, not something
to surface (see Presenting).

(No server means no activity feed, so heat is 0 locally; the other signals
are identical.)

## In-flight awareness — don't re-pick work an agent is already on (Claude Code only)

`spor dispatch` launches Claude Code background agents named after the node id
they work (art-res-task-spor-cli-dispatch-background-agents). Before you
recommend an item, cross-reference live agent state so you don't surface work
that's already in flight — otherwise whoever triages the queue picks up or
re-dispatches a task an agent is already doing. This is **presentation-only and
Claude-Code-only**: the `my_queue` / `GET /v1/queue` server surface cannot see
local background agents, so the cross-reference happens here, at present time.
Best-effort — if the `claude` binary is absent or errors (e.g. in Cowork or a
plain shell), skip it silently and present the queue as usual.

```bash
claude agents --json 2>/dev/null   # array of {name, kind, state, cwd, ...}
```

Treat a queue item as **in flight** when a `kind: "background"` agent has
`name` equal to the item's id and `state` is not `"done"` (e.g. `working`). For
those items: badge them "🤖 agent dispatched — in progress" and keep them OUT of
the top "pick this next" recommendation (the work is already moving; surfacing
it invites duplication). Mention them so the human can still choose to look —
counted, never silently dropped, the same discipline the queue uses for mutes
and leases. Items with no matching live agent are presented normally.

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
