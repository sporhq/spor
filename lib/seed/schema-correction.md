---
id: schema-correction
type: schema
kind: node-schema
schema_version: 2026.07.15.1
title: Seed schema for correction nodes
summary: Node schema for the correction type — standing fix to a briefing: pin/exclude/guidance; never traversed. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `correction` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

`status` vocabulary + `validate()`/`transitions()` (2026.07.15.1,
issue-spor-corrections-no-applied-lifecycle): a correction previously had no
lifecycle — it fired at every future compile of its target forever, even after
a recompile absorbed its guidance into the briefing body, so an applied
correction became pure dead weight injected on every subsequent serve
(corr-brief-proj-spor-1: ~973B redundant on every brief-proj-spor serve since
the v4 recompile absorbed it). `active`/`applied` join the vocabulary,
mirroring the shared `validate()`-is-the-door / `transitions()`-is-the-update-
gate split used by every other seed type (dec-cc-status-enforcement-via-
transitions): `active` (the default — status-less means active, so every
existing correction node keeps firing exactly as before) means the guidance is
still standing and should keep injecting; `applied` means a recompile has
already absorbed it into the target's briefing body, so it should stop firing
(the client twin of that gate is `correctionInScope`/`corrections` in
lib/kernel/graph.js — see its comment for the matching filter; the server's
`correctionsForBriefing`/`applyBriefingCorrections` serve-time twin must stay
in sync, held-guard-style). `applied` is also declared `status.terminal` — a
correction's own lifecycle is done once absorbed, even though it retires
nothing (corrections resolve no other node, so there is no `non_resolving`
partition to declare). Backward-readable: one new optional status value +
write-time gate only, no node-shape change, no upgrade chain — a correction
with no `status:` field resolves to `active` and behaves byte-identically to
before this change.

```json
{
  "node_type": "correction",
  "description": "standing fix to a briefing: pin/exclude/guidance; never traversed",
  "prefix": [
    "corr-"
  ],
  "traversable": false,
  "capturable": false,
  "status": {
    "terminal": [
      "applied"
    ]
  }
}
```

```js
// The correction status vocabulary, shared by validate() (the door, runs on
// create AND update) and transitions() (update only) — same shape as every
// other seed type's status gate (dec-cc-status-enforcement-via-transitions).
// `active` (or no status at all) is the live/default state: the correction
// still fires at every future compile of its target. `applied` means a
// recompile has already absorbed its guidance into the target's briefing
// body, so it should stop firing (issue-spor-corrections-no-applied-lifecycle)
// — the client compile filter and the server serve-time filter both read this
// field; this schema only enforces the vocabulary, not the injection gate.
const VALID = ["active", "applied"];
function statusReason(next) {
  return "invalid correction status '" + next + "': valid statuses are active " +
    "(standing guidance, still injects) or applied (a recompile already " +
    "absorbed it — stops injecting) — or none, meaning active. " +
    "(dec-cc-status-enforcement-via-transitions)";
}

// validate(node) — the door, runs on EVERY write (create AND update) in the
// §2.4 sandbox. Enforce status-vocabulary MEMBERSHIP here so a correction
// cannot be BORN with an off-vocabulary status that the update-path
// transitions() gate would later reject. Empty status (status-less = active)
// is allowed.
export function validate(node) {
  const s = ((node && node.status) || "").toLowerCase();
  if (s === "" || VALID.indexOf(s) !== -1) return [];
  return [statusReason(s)];
}

// transitions(current, proposed, view) — correction status vocabulary gate.
// Runs on every UPDATE in the §2.4 sandbox, JSON boundary, pure. Empty status
// (status-less = active) and the create path are always allowed; the SHARED
// check above also enforces this on create, and transitions() keeps it as the
// update-path guard. No resolver gate: a correction resolves nothing, so
// `applied` needs no supporting edge — the recompile flow that absorbs it is
// the only durable record required.
export function transitions(current, proposed, view) {
  const next = ((proposed && proposed.status) || "").toLowerCase();
  if (next === "" || VALID.indexOf(next) !== -1) return { allow: true };
  return { allow: false, reason: statusReason(next) };
}
```
