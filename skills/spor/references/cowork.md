# Working the graph from Cowork (no shell, no hooks)

Cowork fires no hooks: no session-start briefing, no per-prompt digest, no
capture nudges, and no `spor` CLI. The Spor MCP connector's tools are the
**only** context surface there — nothing arrives ambiently, so you must query
explicitly, before non-trivial work. This is the standing Cowork workflow;
the tool catalog itself is in SKILL.md ("MCP tools").

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

## When the graph can't answer — file a question

A `found: false` is a real gap. If it's something a teammate would know, don't
let it evaporate — file it as a `question` node with `ask_question` so it routes
to whoever does:

```json
{ "text": "Did the OAuth phase B token-rotation hook land?",
  "mentions": ["dec-cc-authz-rebac-fga"] }
```

The server routes the question to the steward of the closest node in its
relevance neighborhood (or leaves it unrouted, visible to everyone, when none
matches) and attributes it to you. `mentions` is weighed first, so name the
nodes the question is about; pass `project` to pin a team when a mention-less
question's neighborhood is empty. Keep `text` to one or two standalone sentences
— it also becomes the question's summary (capped at 500 chars). An answer is any
node carrying an `answers` edge to the question; write that node, `add_edge` the
`answers`, then `set_status` the question to `answered` (terminal).

## After you make a durable decision

When the work produces a fact a teammate would need next week — a decision (with
the why), a dismissed approach (with the reason), a new issue, a convention —
record it. Unsure of the shape? Send raw prose to `capture` and let the server
type it. For a precise write, use `put_node` with the full node markdown per the
team's node format (frontmatter `id`/`type`/`project`/`title`/`summary` + typed
`edges`); `id` is kebab-case and starts with the type prefix (`dec-`, `task-`,
`issue-`, `norm-`, `spec-`/`art-`). The server validates, normalizes, attributes
the node to you, and commits it.

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
  Closing work needs the why on the graph first: a `task` → `done` or `issue`
  → `resolved` is denied unless a `decision` or `artifact` node `resolves` it
  (task-cc-terminal-status-requires-resolver). Write that resolver (a few-line
  artifact is enough for a trivial close) and `add_edge` a `resolves` to the
  item, THEN `set_status`. `abandoned` (task) is exempt.
- Don't upload personal scratch — only promote facts the whole team should share.
- After a substantial multi-node session, also file the **connective** record:
  ONE `artifact` node that says what the session accomplished, carrying edges to
  the nodes it produced (`resolves` what it closed, `relates-to`/`mentions` the
  rest). Nothing triggers this hub automatically — the completion gate only fires
  on a terminal status flip, so a session that produces many nodes but
  terminalizes none has no cue (issue-spor-session-outcome-artifact-capture-gap).
  Write it before the human asks, not just the scattered individual nodes.

## When a briefing or digest was wrong

The `/spor:correct` skill's CLI path isn't available in Cowork, so fix the
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
