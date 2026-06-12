---
id: schema-question
type: schema
kind: node-schema
schema_version: 2026.06.10.1
title: Seed schema for question nodes
summary: Node schema for the question type — a routed ask that the graph could not answer; queueable so open questions join the decision queue, routed-to a steward, answered by nodes carrying answers edges. Seed-pack default; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `question` node type (Tier-2 question routing),
shipped with the plugin as a registry default (QUEUE.md §2). A question is
filed deliberately (the `ask_question` tool / `POST /v1/questions`) when
the graph comes back empty — coordination is durable graph nodes, not
side-channels (dec-cc-inter-session-graph-coordination).

Lifecycle: `status: open` while waiting; an answer is any node carrying an
`answers` edge to the question, after which the asker or answerer flips
`status: answered` (terminal — leaves the queue). The `asker` frontmatter
field records the asking person node; attribution still comes only from
the token. `routed-to` edges carry the routing result; an unrouted
question (no steward matched) surfaces to everyone.

```json
{
  "node_type": "question",
  "description": "a routed ask the graph could not answer — open questions join the decision queue",
  "prefix": [
    "question-"
  ],
  "queueable": true
}
```
