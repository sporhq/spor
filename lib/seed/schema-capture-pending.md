---
id: schema-capture-pending
type: schema
kind: node-schema
schema_version: 2026.06.20.1
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

`validate()` (2026.06.20.1, issue-spor-node-create-bypasses-status-vocabulary):
the allowed-status membership check moved to the `validate()` door so it runs on
**create as well as update** — `transitions()` runs on update only, so a node
could be BORN with an off-vocabulary status that a later re-validating write then
rejected. `validate()` and `transitions()` SHARE one allowed set (no drift).
Backward-readable: write-time only, no node-shape change, no upgrade chain.

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
// The capture-pending status vocabulary, shared by validate() (the door, runs
// on create AND update) and transitions() (update only). A capture-pending node
// is born status-less (live, awaiting triage) and closes exactly two ways:
//   merged   — its content now lives in proper node(s); the capture was a
//              duplicate/elaboration and leaves the queue.
//   rejected — no durable fact worth keeping.
// Any other status (the historical dismissed/resolved/closed drift) is denied:
// dismissed was never terminal to the queue kernel (lib/kernel/resolution.js),
// so it produced captures that looked triaged yet kept ranking live
// (issue-cc-dismissed-status-not-terminal, dec-cc-status-enforcement-via-transitions).
// Defining the allowed set ONCE is what makes the create path and the update
// path AGREE (issue-spor-node-create-bypasses-status-vocabulary): the membership
// check used to live only in the update-path gate.
const VALID = ["merged", "rejected"];
function statusReason(next) {
  return "invalid capture-pending status '" + next + "': a capture closes only " +
    "as 'merged' (its content now lives in proper node(s) — write those nodes " +
    "first, then set merged) or 'rejected' (no durable fact worth keeping). " +
    "Do not use dismissed/resolved/closed — they are not terminal to the queue " +
    "and leave the capture ranking live (dec-cc-status-enforcement-via-transitions).";
}

// validate(node) — the door, runs on EVERY write (create AND update) in the
// §2.4 sandbox. Enforce the allowed-status MEMBERSHIP here so a capture-pending
// node cannot be BORN with an off-vocabulary status that the update-path
// transitions() gate would later reject
// (issue-spor-node-create-bypasses-status-vocabulary). Empty status
// (status-less = live, the create default or re-opening to pending) is allowed.
export function validate(node) {
  const s = ((node && node.status) || "").toLowerCase();
  if (s === "" || VALID.indexOf(s) !== -1) return [];
  return [statusReason(s)];
}

// transitions(current, proposed, view) — capture triage gate. Runs on every
// UPDATE in the §2.4 sandbox, JSON boundary, pure. An empty status (the create
// path, or re-opening to pending) is always allowed; the SHARED check above also
// enforces the allowed set on create now, and transitions() keeps it as the
// update-path guard.
export function transitions(current, proposed, view) {
  const next = ((proposed && proposed.status) || "").toLowerCase();
  if (next === "" || VALID.indexOf(next) !== -1) return { allow: true };
  return { allow: false, reason: statusReason(next) };
}
```
