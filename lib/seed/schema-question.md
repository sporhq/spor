---
id: schema-question
type: schema
kind: node-schema
schema_version: 2026.06.13.1
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

`transitions()` (2026.06.13.1): status is constrained to the question
vocabulary (`open`/`answered`, or none = live) so the queue-terminal value
(`answered`) is not shadowed by synonyms
(dec-cc-status-enforcement-via-transitions). Write-time gate,
backward-readable, no upgrade chain.

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

```js
// transitions(current, proposed, view) — question status vocabulary gate
// (dec-cc-status-enforcement-via-transitions). Runs on every UPDATE in the
// §2.4 sandbox, JSON boundary, pure. Empty status (status-less = live, an
// open question) and the create path are always allowed; the denial reason
// names the valid set so a writing agent can correct and retry.
export function transitions(current, proposed, view) {
  const VALID = ["open", "answered"];
  const next = ((proposed && proposed.status) || "").toLowerCase();
  if (next === "" || VALID.indexOf(next) !== -1) return { allow: true };
  return {
    allow: false,
    reason: "invalid question status '" + next + "': valid statuses are open " +
      "(awaiting an answer) and answered (an answers edge resolved it; " +
      "terminal) — or none, meaning live. (dec-cc-status-enforcement-via-transitions)",
  };
}
```
