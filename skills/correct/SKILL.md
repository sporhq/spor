---
name: correct
description: Record a standing correction to a Spor briefing (pin/exclude nodes, add guidance). Use when the user says a briefing was wrong, missed something, or included something stale — debug the context, not the model.
---

# Record a correction

Corrections are nodes. They persist in the graph and are applied at every
future compile of their target — a context fix made once applies forever.

**Resolve mode silently.** The Spor status line injected at session start tells
you which mode you're in (`team graph: …` = remote, `A Spor knowledge graph is
active: …` = local); use it, or test `[ -n "$SPOR_SERVER" ]` once if it isn't in
context. Don't echo `SPOR_SERVER`/`SPOR_TOKEN`/`SPOR_HOME` or announce the mode
to the user unless they ask, and run the local-mode resolution below without
echoing `$SPOR_ROOT`.

## Remote mode (team graph) — when `SPOR_SERVER` is set

(Env vars here are the `SPOR_*` family; the legacy `SUBSTRATE_*` names are
still read.)

If `SPOR_SERVER` is set, the briefing came from the TEAM graph, so the
correction MUST go to the server — writing it to the local graph home would
never affect the team's compiles. POST it to `/v1/corrections` (the REST twin of
the `propose_correction` MCP tool, API.md §3); the server generates the
`corr-<target>-<n>` id, builds the node, validates, and commits it:

```bash
curl -sS --max-time 6 -X POST \
  -H "Authorization: Bearer $SPOR_TOKEN" -H "Content-Type: application/json" \
  --data "$(jq -n --arg t '<node-id | project:<slug> | global>' --arg g '<guidance>' --arg ti '<one line>' \
    '{target:$t, pin:[], exclude:[], guidance:$g, title:$ti}')" \
  "${SPOR_SERVER%/}/v1/corrections"
```

`pin`/`exclude` entries must be existing node ids (verify with
`GET ${SPOR_SERVER%/}/v1/nodes/<id>`); the server rejects non-id values. If
the knowledge isn't a node yet, create it first via `POST /v1/nodes` (or the
`put_node` tool), then pin it. In Cowork, use the `propose_correction` MCP tool
directly with the same fields — there is no filesystem or compile.js there.
Skip the local steps below; you are done once the server returns
`{"status":"created", ...}`.

## Local mode (personal graph) — `SPOR_SERVER` unset

The graph home below is `~/.spor` by default (an existing `~/.substrate` is
still used when `~/.spor` is absent).

1. Identify the target — corrections fire only when their target is in scope
   for a given compile:
   - a **node id** (the node the bad briefing was compiled for — check
     `compiled-for` edges on the briefing node): fires when that node is the
     compile root or one of the nodes a query matched. This is the right scope
     for a fix about one specific topic; it now applies in query/digest mode
     too, not just root-mode briefings
     (issue-cc-corrections-silent-noop-query-mode).
   - `project:<slug>`: fires on every compile for that project (the slug
     resolves through project aliases, so a historical name still matches).
     Use this for project-wide guidance.
   - `global`: fires on EVERY compile, for every project and teammate — the
     broadest scope. Reserve it for graph-wide norms; prefer `project:<slug>`
     when the guidance is project-specific.

2. Establish what went wrong, from the user or from the conversation:
   - a relevant node was missed → `pin: [that-id]` (verify the id exists in
     `~/.spor/nodes/`; if the knowledge isn't a node yet, create that node
     first per the plugin's GRAPH.md, then pin it)
   - an irrelevant/stale node was included → `exclude: [that-id]`
     - exception: if the irrelevant node is a **norm bleeding in across repos**
       (e.g. a `uv` norm showing up in a terraform or Go brief under the same
       project), the durable fix is to scope the norm at its source — add
       `applies_to_tags:`/`applies_to_repos:`/`applies_to_projects:` to the norm
       node and `tags:` to the repos (see GRAPH.md / concepts.md) — not a
       per-briefing `exclude` you'd have to repeat everywhere it bleeds.
   - emphasis/framing was wrong → free-text guidance in the body

3. Write `~/.spor/nodes/corr-<target>-<n>.md` (n = next free integer):

```markdown
---
id: corr-<target>-<n>
type: correction
title: <one line: what this fixes>
target: <node-id | project:<slug> | global>
pin: [id, id]
exclude: [id]
date: <today>
---

<guidance injected verbatim into every compile of the target>
```

4. Verify it applies. `${CLAUDE_PLUGIN_ROOT}` is empty in the Bash tool, so
   resolve the plugin root from the session-start cache first
   (issue-cc-skill-plugin-root-unsubstituted):
   ```bash
   SPOR_ROOT="$(cat "${SPOR_HOME:-$HOME/.spor}/cache/plugin-root" 2>/dev/null \
     || cat "$HOME/.substrate/cache/plugin-root" 2>/dev/null)"
   SPOR_ROOT="${SPOR_ROOT:-$CLAUDE_PLUGIN_ROOT}"
   ```
   Recompile the target (`node "$SPOR_ROOT/lib/compile.js" --root <target>`
   or `--query`) and confirm the pinned/excluded nodes and guidance show up.
   Then run `node "$SPOR_ROOT/lib/validate.js"` and fix anything it flags.
