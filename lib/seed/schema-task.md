---
id: schema-task
type: schema
kind: node-schema
schema_version: 2026.06.14.1
title: Seed schema for task nodes
summary: Node schema for the task type — active or planned work. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `task` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

`transitions()` (2026.06.14.1): two write-time gates. (1) Status is
constrained to the task vocabulary (`open`/`active`/`done`/`abandoned`, or
none = live) so the queue-terminal value (`done`) is not shadowed by synonyms
— the same class of drift that left captures ranking live under a non-terminal
`dismissed` (dec-cc-status-enforcement-via-transitions). (2) Completion
(`done`) additionally requires a durable outcome ON THE GRAPH: a live inbound
`resolves` edge from a `decision` or `artifact` node, read off `view.resolvers`
(task-cc-terminal-status-requires-resolver). Even a few lines of artifact —
what was done, like a commit message — beats a bare status flip, because the
node surfaces in the neighborhood. `abandoned` (won't do) is exempt; nothing
was produced to record. Both are write-time gates, backward-readable (no
stored-shape change; existing `done` tasks are untouched), no upgrade chain.

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
// transitions(current, proposed, view) — task status gate. Runs on every
// UPDATE in the §2.4 sandbox, JSON boundary, pure. Empty status (status-less =
// live) and the create path are always allowed; denial reasons are actionable
// so a writing agent can correct and retry.
export function transitions(current, proposed, view) {
  const VALID = ["open", "active", "done", "abandoned"];
  const next = ((proposed && proposed.status) || "").toLowerCase();
  if (next === "") return { allow: true };
  // (1) vocabulary gate (dec-cc-status-enforcement-via-transitions).
  if (VALID.indexOf(next) === -1) {
    return {
      allow: false,
      reason: "invalid task status '" + next + "': valid statuses are open " +
        "(planned), active (in progress), done (completed), abandoned (won't do) " +
        "— or none, meaning live. (dec-cc-status-enforcement-via-transitions)",
    };
  }
  // (2) completion must record a durable outcome on the graph: a decision or
  // artifact that resolves this task (task-cc-terminal-status-requires-resolver).
  // `abandoned` is exempt. view.resolvers = live inbound resolves/answers edges
  // with their source type.
  if (next === "done") {
    const rs = (view && view.resolvers) || [];
    let ok = false;
    for (let i = 0; i < rs.length; i++) {
      if (rs[i].type === "decision" || rs[i].type === "artifact") { ok = true; break; }
    }
    if (!ok) {
      return {
        allow: false,
        reason: "done requires a decision or artifact node that resolves this " +
          "task (an inbound resolves edge) — record the outcome on the graph, " +
          "even a few lines like a commit message, so it surfaces in the " +
          "neighborhood; or set abandoned if it won't be done. " +
          "(task-cc-terminal-status-requires-resolver)",
      };
    }
  }
  return { allow: true };
}
```
