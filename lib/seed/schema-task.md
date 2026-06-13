---
id: schema-task
type: schema
kind: node-schema
schema_version: 2026.06.13.1
title: Seed schema for task nodes
summary: Node schema for the task type — active or planned work. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `task` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

`transitions()` (2026.06.13.1): status is constrained to the task vocabulary
(`open`/`active`/`done`/`abandoned`, or none = live) so the queue-terminal
value (`done`) is not shadowed by synonyms — the same class of drift that left
captures ranking live under a non-terminal `dismissed`
(dec-cc-status-enforcement-via-transitions). Write-time gate, backward-readable,
no upgrade chain.

```json
{
  "node_type": "task",
  "description": "active or planned work",
  "prefix": [
    "task-"
  ],
  "queueable": true
}
```

```js
// transitions(current, proposed, view) — task status vocabulary gate
// (dec-cc-status-enforcement-via-transitions). Runs on every UPDATE in the
// §2.4 sandbox, JSON boundary, pure. Empty status (status-less = live) and the
// create path are always allowed; the denial reason names the valid set so a
// writing agent can correct and retry.
export function transitions(current, proposed, view) {
  const VALID = ["open", "active", "done", "abandoned"];
  const next = ((proposed && proposed.status) || "").toLowerCase();
  if (next === "" || VALID.indexOf(next) !== -1) return { allow: true };
  return {
    allow: false,
    reason: "invalid task status '" + next + "': valid statuses are open " +
      "(planned), active (in progress), done (completed), abandoned (won't do) " +
      "— or none, meaning live. (dec-cc-status-enforcement-via-transitions)",
  };
}
```
