---
name: defer
description: Capture deferred or discovered work into the Spor graph the moment it appears — an out-of-scope fix, a follow-up, a dismissed approach, a "we should really…". One call; the server types it, links it, and resurfaces it when a session next works nearby. Use whenever work is being postponed instead of done, or when the user says to remember/file/defer something.
---

# Capture deferred work

Discovered work dies in TODO comments. Capture it instead: the Spor graph
resurfaces it automatically the moment a future session touches its
neighborhood — no backlog grooming required (QUEUE.md §1/§3).

Write 2-3 standalone sentences: WHAT the work is and WHY it was deferred
(the deferral reason is often itself a decision worth keeping). Include
concrete names (files, endpoints, node ids). Do not pick node types or ids —
the server's ingestion model does that against the live schema registry.

## Remote mode (team graph) — when `SPOR_SERVER` is set

(Env vars here are the `SPOR_*` family; the legacy `SUBSTRATE_*` names are
still read.)

POST the raw text to `/v1/capture` (the REST twin of the `capture` MCP tool).
Derive the project slug the same way the hooks do (kebab-cased basename of the
git toplevel), and pass a `during` node id if the current task corresponds to
a known graph node (check the session's briefing/digest for its id):

```bash
TOP=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
# a committed .spor marker (project: <id>) beats basename inference
SLUG=$(sed -nE 's/^project:[ \t]*([a-z0-9][a-z0-9-]*)[ \t]*$/\1/p' "$TOP/.spor" 2>/dev/null | head -1)
[ -n "$SLUG" ] || SLUG=$(basename "$TOP" \
  | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
curl -sS --max-time 90 -X POST \
  -H "Authorization: Bearer $SPOR_TOKEN" -H "Content-Type: application/json" \
  --data "$(jq -n --arg t '<the 2-3 sentences>' --arg p "$SLUG" \
    '{text: $t, context: {project: $p}}')" \
  "${SPOR_SERVER%/}/v1/capture"
# with a during hint: '{text: $t, context: {project: $p, during: "<node-id>"}}'
```

Read the response and tell the user what happened, briefly:

- `"status": "captured"` — report the node id(s) from `ids` and the one-line
  `summary`. Done.
- `"status": "pending"` — the text fit no schema; it was preserved as a
  `cap-…` node for later triage. Say so; nothing is lost.
- `503 ingestion_unavailable` — the server's ingestion model is down. Offer
  to retry, or fall back to the local-mode steps below so the fact still
  lands somewhere durable.

In Cowork, call the `capture` MCP tool directly with the same fields
(`text`, `project`, `during`) — there is no shell there.

## Local mode (personal graph) — `SPOR_SERVER` unset

There is no server-side ingester locally, so write the node yourself, the
GRAPH.md way: a `task-<kebab-slug>.md` file in `$SPOR_HOME/nodes/` (default
`~/.spor/nodes/`; an existing `~/.substrate` is still used when `~/.spor` is
absent) with id = filename minus `.md`, `type: task`,
`project: <slug>`, a standalone `summary`, today's `date`, and a
`derived-from` edge to the node the work was discovered during, if known.
If the deferral reason is load-bearing ("because the release is Friday"),
record it in the body. Then validate — `${CLAUDE_PLUGIN_ROOT}` is empty in
the Bash tool, so resolve the plugin root from the session-start cache first
(issue-cc-skill-plugin-root-unsubstituted):
```bash
SPOR_ROOT="$(cat "${SPOR_HOME:-$HOME/.spor}/cache/plugin-root" 2>/dev/null \
  || cat "$HOME/.substrate/cache/plugin-root" 2>/dev/null)"
SPOR_ROOT="${SPOR_ROOT:-$CLAUDE_PLUGIN_ROOT}"
node "$SPOR_ROOT/lib/validate.js"
```
Fix anything it flags, and commit the graph repo if it is one.
