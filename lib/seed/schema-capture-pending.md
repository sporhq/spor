---
id: schema-capture-pending
type: schema
kind: node-schema
schema_version: 2026.06.13.1
title: Seed schema for capture-pending nodes
summary: Node schema for the capture-pending type — raw captured text that fit no schema; filed by the server for later triage. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `capture-pending` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

`transitions()` (2026.06.13.1): a capture-pending node is born status-less
(live, awaiting triage) and may close only as `merged` (its content now lives
in proper node(s)) or `rejected` (no durable fact). Earlier triage drifted
across `dismissed`/`resolved`/`closed`; `dismissed` in particular is not
terminal to the queue kernel (lib/kernel/resolution.js), so those captures
looked triaged yet kept ranking live
(issue-cc-dismissed-status-not-terminal). The gate forbids the drift at write
time rather than hardcoding a value set; chosen over a declarative status enum
because the gate is write-time on the current→proposed transition, so it never
re-validates nodes at rest and needs no upgrade chain
(dec-cc-status-enforcement-via-transitions). Backward-readable: a write-time
gate, no node-shape change.

```json
{
  "node_type": "capture-pending",
  "description": "raw captured text that fit no schema; filed by the server for later triage",
  "prefix": [
    "cap-"
  ],
  "capturable": false,
  "queueable": true
}
```

```js
// transitions(current, proposed, view) — capture triage gate. Runs on every
// UPDATE in the §2.4 sandbox, JSON boundary, pure. A capture-pending node is
// born status-less (live, awaiting triage) and is closed exactly two ways:
//   merged   — its content now lives in proper node(s); the capture was a
//              duplicate/elaboration and leaves the queue.
//   rejected — no durable fact worth keeping.
// Any other status (the historical dismissed/resolved/closed drift) is denied:
// dismissed was never terminal to the queue kernel (lib/kernel/resolution.js),
// so it produced captures that looked triaged yet kept ranking live
// (issue-cc-dismissed-status-not-terminal, dec-cc-status-enforcement-via-transitions).
// An empty status (the create path, or re-opening to pending) is always
// allowed. The reason on denial names the allowed values and what each means
// so the writing agent can correct and retry without guessing.
export function transitions(current, proposed, view) {
  const next = ((proposed && proposed.status) || "").toLowerCase();
  if (next === "" || next === "merged" || next === "rejected") return { allow: true };
  return {
    allow: false,
    reason: "invalid capture-pending status '" + next + "': a capture closes only " +
      "as 'merged' (its content now lives in proper node(s) — write those nodes " +
      "first, then set merged) or 'rejected' (no durable fact worth keeping). " +
      "Do not use dismissed/resolved/closed — they are not terminal to the queue " +
      "and leave the capture ranking live (dec-cc-status-enforcement-via-transitions).",
  };
}
```
