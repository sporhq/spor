---
name: correct
description: Record a standing correction to a Spor briefing (pin/exclude nodes, add guidance). Use when the user says a briefing was wrong, missed something, or included something stale — debug the context, not the model.
---

# Record a correction

Corrections are nodes. They persist in the graph and are applied at every
future compile of their target — a context fix made once applies forever.

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
  --data "$(jq -n --arg t '<node-id or global>' --arg g '<guidance>' --arg ti '<one line>' \
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

1. Identify the target: the node id the bad briefing was compiled for (check
   `compiled-for` edges on the briefing node), or `global` for guidance that
   should apply to every compile in this project.

2. Establish what went wrong, from the user or from the conversation:
   - a relevant node was missed → `pin: [that-id]` (verify the id exists in
     `~/.spor/nodes/`; if the knowledge isn't a node yet, create that node
     first per the plugin's GRAPH.md, then pin it)
   - an irrelevant/stale node was included → `exclude: [that-id]`
   - emphasis/framing was wrong → free-text guidance in the body

3. Write `~/.spor/nodes/corr-<target>-<n>.md` (n = next free integer):

```markdown
---
id: corr-<target>-<n>
type: correction
title: <one line: what this fixes>
target: <node-id or global>
pin: [id, id]
exclude: [id]
date: <today>
---

<guidance injected verbatim into every compile of the target>
```

4. Verify it applies: recompile the target
   (`node ${CLAUDE_PLUGIN_ROOT}/lib/compile.js --root <target>` or `--query`)
   and confirm the pinned/excluded nodes and guidance show up. Then run
   `node ${CLAUDE_PLUGIN_ROOT}/lib/validate.js` and fix anything it flags.
