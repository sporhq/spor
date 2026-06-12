---
name: next
description: Present the Spor decision queue — what to work on next, ranked by graph signals (what each item blocks, neighborhood activity, age, staleness) alongside human-set priority. Use when the user asks "what should I work on", "what's next", "show the queue / backlog", or wants to triage deferred work and pending captures.
---

# What should I work on next?

The queue is computed from the graph, not kept as a list (QUEUE.md §4/§5):
queueable live nodes (deferred tasks, unprocessed captures, org-defined
types) ranked by an advisory blend — what they block, recent activity in
their neighborhood, age — plus any human-set `priority:`. High staleness
(anchors superseded or gone) flips the suggestion to **close**, not do.

## Remote mode (team graph) — when `SPOR_SERVER` is set

(Env vars here are the `SPOR_*` family; the legacy `SUBSTRATE_*` names are
still read.)

```bash
SLUG=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" \
  | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
curl -sS --max-time 6 -H "Authorization: Bearer $SPOR_TOKEN" \
  "${SPOR_SERVER%/}/v1/queue?project=$SLUG&limit=10"
# org-wide view: drop the project filter
```

In Cowork, call the `my_queue` MCP tool with the same fields.

## Local mode (personal graph) — `SPOR_SERVER` unset

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/queue.js            # or --project <slug>, --json
```

(No server means no activity feed, so heat is 0 locally; the other signals
are identical.)

## Presenting and acting

Show the ranked items with their `why` lines and any `suggest: close` flags —
the signals are advisory; the human picks. Then:

1. **Item picked to DO** → start pre-briefed: run a full root compile for it
   (/spor:brief `<item-id>`, or locally
   `node ${CLAUDE_PLUGIN_ROOT}/lib/compile.js --root <item-id>`) and begin
   from that briefing.
2. **Item picked to CLOSE** (or `suggest: close` confirmed) → flip the
   node's `status:` with `set_status` (one call, no revision round-trip;
   locally edit the file). If the reason deserves recording, note it in the
   body via `put_node`.
3. **`capture-pending` item** → read it (`GET /v1/nodes/<id>`), decide what
   it should have been, write the proper node(s), then mark the pending node
   resolved with `set_status`.
