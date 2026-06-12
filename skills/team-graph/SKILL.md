---
name: team-graph
description: Check the team knowledge graph (Spor) for prior decisions, constraints, dismissed approaches, and team norms before starting non-trivial work, and record durable outcomes back to it. Use BEFORE designing, deciding, or building anything non-trivial; use AFTER making a decision worth keeping, or when a briefing was wrong. This is the only context surface in Cowork — there is no ambient injection here, so query it explicitly.
---

# Use the team knowledge graph

Spor is your team's shared, typed knowledge graph: decisions (including
the ones that were dismissed and why), issues, norms, specs, and tasks — one
fact per node, with typed lineage edges. In Claude Code it is injected
automatically by hooks. **Cowork fires no hooks**, so here you must reach it
yourself through the Spor MCP connector's tools. Querying it before
non-trivial work is what stops the team relitigating settled questions and
re-treading dismissed approaches.

## Before you design or decide anything non-trivial

1. Call `query_graph` with a plain-language description of the task or question
   (the more concrete, the better the compile):

   ```json
   { "query": "add per-tenant rate limiting to the API gateway", "mode": "digest" }
   ```

   - `found: false` is a **successful empty result**, not an error — the graph
     simply has nothing relevant. Proceed, but consider recording what you
     decide (below) so the next person isn't starting cold.
   - `found: true` returns a compact digest plus `node_ids`. Read it before
     writing anything. For the full neighborhood of one node, call again with
     `mode: "full"` or pass its id as `root_id`.

2. **Honor ⚠ SUPERSEDED warnings.** A node flagged superseded is stale — its
   successor is pulled into the same digest. Follow the successor; do not act on
   the stale node. Likewise, treat `status: rejected` decisions as "we tried
   this and chose not to" — the reason is in the node.

3. Let constraints bind you. Nodes reached by `constrained-by` / `governed-by`
   lineage and any `norm-*` nodes are standing rules, not suggestions. Cite the
   node ids you relied on so your reasoning is traceable.

## After you make a durable decision

When the work produces a fact a teammate would need next week — a decision (with
the why), a dismissed approach (with the reason), a new issue, a convention —
record it with `put_node`. Write the full node markdown per the team's node
format (frontmatter `id`/`type`/`project`/`title`/`summary` + typed `edges`);
`id` is kebab-case and starts with the type prefix (`dec-`, `task-`, `issue-`,
`norm-`, `spec-`/`art-`). The server validates, normalizes, attributes the node
to you, and commits it.

```json
{ "node": "---\nid: dec-...\ntype: decision\n...\n---\n\n<body>", "if_exists": "skip" }
```

- Dismissed approaches matter as much as adopted ones — record them with
  `status: rejected` and the reason.
- If validation fails, the response carries the validator's error list; fix the
  node and retry. Do not invent edge types — use the documented set
  (`supersedes`, `constrained-by`, `governed-by`, `derived-from`, `decided-in`,
  `resolves`, `blocks`, `relates-to`, `mentions`); the tool description
  carries the live vocabulary. Inverse forms (`blocked-by`, `answered-by`,
  `superseded-by`) are accepted and flipped onto the target node.
- For a single relationship or a status flip on an EXISTING node, prefer the
  micro-mutations: `add_edge {id, type, to}` and `set_status {id, status}` —
  one call, no `get_node`/revision round-trip, duplicate edges are a no-op.
- Don't upload personal scratch — only promote facts the whole team should share.

## When a briefing or digest was wrong

You can't run the `/spor:correct` slash command in Cowork, so fix the
context with `propose_correction` instead. Corrections are standing nodes
applied at every future compile of their target — debug the context once, not
the model every time:

```json
{
  "target": "issue-86",
  "pin": ["spec-actor-model"],
  "exclude": ["art-stale-notes"],
  "guidance": "Always brief the actor-model spec when touching issue-86.",
  "title": "Pin the actor-model spec when briefing issue-86"
}
```

`target` is a node id, or `"global"` to apply to every compile. Use `pin` to
force a missed node in, `exclude` to drop a stale/irrelevant one, and `guidance`
for free-text framing. The server creates the `corr-<target>-<n>` node and routes
it through the same write path.
