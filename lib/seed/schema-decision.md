---
id: schema-decision
type: schema
kind: node-schema
schema_version: 2026.06.13.1
title: Seed schema for decision nodes
summary: Node schema for the decision type — a choice that was made, with the why. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `decision` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

`transitions()` (2026.06.13.1): status is constrained to the decision
vocabulary (`active`/`superseded`/`rejected`, or none = live) so the
queue-terminal values are not shadowed by synonyms
(dec-cc-status-enforcement-via-transitions). `rejected` is how a dismissed
approach is filed (the distiller writes it, prompts/client/distill-local.md).
Write-time gate, backward-readable, no upgrade chain.

```json
{
  "node_type": "decision",
  "description": "a choice that was made, with the why",
  "prefix": [
    "dec-"
  ]
}
```

```js
// transitions(current, proposed, view) — decision status vocabulary gate
// (dec-cc-status-enforcement-via-transitions). Runs on every UPDATE in the
// §2.4 sandbox, JSON boundary, pure. Empty status (status-less = live, the
// common case for an in-force decision) and the create path are always
// allowed; the denial reason names the valid set so a writing agent can
// correct and retry.
export function transitions(current, proposed, view) {
  const VALID = ["active", "superseded", "rejected"];
  const next = ((proposed && proposed.status) || "").toLowerCase();
  if (next === "" || VALID.indexOf(next) !== -1) return { allow: true };
  return {
    allow: false,
    reason: "invalid decision status '" + next + "': valid statuses are active " +
      "(in force), superseded (replaced by a newer decision), rejected " +
      "(recorded then declined/reversed — also how a dismissed approach is " +
      "filed) — or none, meaning live. (dec-cc-status-enforcement-via-transitions)",
  };
}
```
