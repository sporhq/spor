---
id: schema-register-terminal-status
type: schema
kind: register
schema_version: 2026.07.16.1
title: Seed schema for the type-blind terminal-status register
summary: Registry-declared extensible enum (kind register) for the type-blind terminal-status vocabulary — the status values that retire ANY node from queue liveness, briefing "live work" surfacing, and coupling-norm matching. The kernel exposes it as a partition (graph.registry.registerClasses("terminal-status")) instead of two divergent hardcoded tables in lib/kernel/resolution.js and lib/kernel/coupling.js. Seed default; a graph-resident register schema for this name overrides/extends it.
date: 2026-07-16
---

Seed schema for the `terminal-status` register (ontology in GRAPH.md), shipped
with the plugin as a registry default (QUEUE.md §2). A `type: schema` node in
the graph with `kind: register` and `register: terminal-status` grows this
vocabulary by editing a schema node, never a code change
(norm-cc-registry-is-contract). Note this is NOT the generic `Registry.add()`
winner-take-all replacement every other register slot gets (a resident
`requires` register, say, fully REPLACES the seed's classes) — a resident
override naming only its own new status would otherwise silently drop the
seed's dozen values and un-terminal every resolved/done/merged/… node in the
graph, a graph-wide liveness regression from a single doc-encouraged schema
edit. `lib/kernel/resolution.js`'s `terminalVocabulary(graph)` instead UNIONS
`graph.registry.registerClasses("terminal-status")` onto the fallback seed set
below, so a resident schema only ever ADDS statuses; it cannot remove one of
the seed's.

An audit found `lib/kernel/coupling.js` and `lib/kernel/resolution.js` each
hardcoding their OWN terminal-status list, and the two had drifted:
coupling.js recognized `retired`/`deprecated` (so a retired norm stops
matching) that resolution.js didn't, and resolution.js recognized
`completed`/`abandoned`/`answered`/`merged` that coupling.js didn't. Neither
recognized `released` (an artifact's shipped delivery stage), so a released
artifact never retired from queue liveness even though `merged`/`done`
correctly did (issue-spor-coupling-resolution-terminal-status-divergence).
This register is the single, unioned source both modules now read: seed
`schema-register-terminal-status` declares the classes below; resolution.js's
`terminalVocabulary(graph)` reads `graph.registry.registerClasses(
"terminal-status")` when a registry is resolvable, falling back to a hardcoded
`TERMINAL_FALLBACK` (byte-identical to this register's classes) for a graph
with no registry or a caller with no graph object at all — the case
coupling.js is ALWAYS in, since it scans node files in the hook tool loop
without a loaded graph (dec-spor-coupling-norms-declared-first; "the
consumers of this module run in the hook tool loop without one").

This register is **type-blind** and DISTINCT from both registry partitions a
node-schema declares under `status:` (dec-spor-definition-of-done-org-policy):
`non_resolving` (does a node, acting as a RESOLVER, retire OTHERS) and
`terminal` (is a node's OWN lifecycle done, read only by work-analytics —
issue-spor-analytics-completion-ignores-schema-terminal-status). A decision's
`settled` status is terminal for that own-lifecycle partition but is
deliberately ABSENT from this register: queue liveness and briefing surfacing
must keep a settled decision live (dec-spor-decision-lifecycle-surfacing), so
this vocabulary stays the narrower, type-blind set — adding a status here
retires it from queues/briefings/coupling-matching for EVERY node type, so
only genuinely universal completion words belong.

```json
{
  "register": "terminal-status",
  "description": "the type-blind status vocabulary that retires ANY node from queue liveness, briefing live-work surfacing, and coupling-norm matching — read by lib/kernel/resolution.js and lib/kernel/coupling.js instead of two divergent hardcoded tables",
  "classes": [
    { "id": "abandoned", "description": "won't-do work; produces nothing to record" },
    { "id": "answered", "description": "a question's terminal status" },
    { "id": "closed", "description": "generic closure" },
    { "id": "completed", "description": "generic completion" },
    { "id": "deprecated", "description": "no longer in force (a coupling norm stops matching)" },
    { "id": "dismissed", "description": "a gardener finding deliberately dismissed — sticky, never auto-reopened" },
    { "id": "done", "description": "a task's terminal status" },
    { "id": "merged", "description": "landed on the default branch — a triaged capture-pending, or an artifact's delivery stage" },
    { "id": "rejected", "description": "recorded then declined/reversed" },
    { "id": "released", "description": "an artifact's shipped delivery stage" },
    { "id": "resolved", "description": "an issue's terminal status" },
    { "id": "retired", "description": "no longer in force (a coupling norm stops matching)" },
    { "id": "superseded", "description": "replaced by a newer node" }
  ]
}
```
