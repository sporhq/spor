---
id: schema-routine
type: schema
kind: node-schema
schema_version: 2026.06.18.1
title: Seed schema for routine nodes
summary: Node schema for the routine type — owner-scoped (owned-by a person) trigger→action automation: declarative when→do rules over graph events that dispatch ONLY the owner's agents, AND-ed with org policy. Declarative register first; attached sandboxed code is a later schema-gated escape hatch. Seed-pack default; a graph-resident schema node for this type overrides it.
date: 2026-06-18
---

Seed schema for the `routine` node type (ontology in GRAPH.md), shipped with the
plugin as a registry default (QUEUE.md §2). A `type: schema` node in the graph
with `kind: node-schema` and the same `node_type` overrides this entry.

A routine is the orchestration layer's per-person automation
(dec-spor-agent-orchestration-layer): a node `owned-by` a person
(schema-edge-owned-by) holding `when → do` rules that fire on graph events. The
sonnet-implements → opus-reviews → approve/send-back/escalate loop and the "a
task touching docs reaches done → dispatch the docs-profile agent" handoff are
routines.

**Two invariants** (from the parent decision):

1. **Only the owner's agents are ever dispatched.** Enforced by the trigger
   locus — locally your machine runs only your routines for your agents;
   remotely the server fires a person's routine only for that person's work and
   can only mint tokens for agents they own. The `person → routine → agent` RFC
   8693 act-chain is the audit trail (dec-cc-attribution-from-token,
   dec-cc-workflow-credential-issuance).
2. **Personal routines accelerate; org policy gates — they AND, never bypass.**
   Agent-on-behalf-of-X counts as X for the self-approval ban and the
   definition-of-done quorum (dec-spor-definition-of-done-org-policy), so an
   owner's reviewer-agent CANNOT auto-approve their implementer-agent's work past
   the org review bar. A routine gets work pre-vetted and clean; independent
   approvals still require other people.

**Declarative register first** (dec-spor-orchestration-routine-requires-threads
thread 1). A routine instance carries its rules as a fenced ```json `rules` block
in its BODY (the regex frontmatter parser is flat, so structured rules live in
the body, exactly as a schema's payload does; the deferred routine ENGINE parses
and runs them). The bounded vocabulary:

- **Triggers (`when`)** are graph events — a status change (e.g. to a resolving
  state, or to `done`), or an edge appearing (e.g. `reviewed-by` /
  `changes-requested-by`) — with `where:` filters (type, project, requires,
  assignee, …).
- **Actions (`do`)** are the bounded verb set: `create-node`, `assign` (to a
  SPECIFIC agent, optionally with a `profile:` override), `dispatch`,
  `set-status`, `reassign`, `escalate` (to the owner). Arbitrary attached
  sandboxed code is the LATER schema-gated escape hatch, gated like lens/schema
  code (dec-lens-custom-wasm-timing) — NOT this schema.

Shape of an instance body (documented for the engine; not parsed by the kernel —
shown as `jsonc` so the seed parser does not mistake it for this schema's own
payload, which is the first ```json block below):

```jsonc
{
  "rules": [
    {
      "when": { "event": "status-change", "to": "resolving", "where": { "type": "task", "project": "spor" } },
      "do": [ { "action": "dispatch", "to": "agent-x", "profile": "profile-y" } ]
    }
  ]
}
```

This schema fixes the routine's IDENTITY and its declarative vocabulary only. The
routine ENGINE and its vetting machinery — dry-run, the mandatory retry budget,
self-approval-floor activation review (a routine that auto-dispatches against
shared state is `proposed` until a different identity activates it), and the
fire-time org-policy gate (thread 2) — ride on the engine, deferred. So this
seed schema is declarative and UNGATED: `status:` is plain data
(backward-readable), no `transitions()` enum ships here; the activation gate is
added (with a `schema_version` bump) when the engine lands.

`capturable: false`: a routine is authored deliberately by its owner, never
drafted from a capture or distilled from a transcript — mirroring `agent`,
`profile`, `person`, and `workflow-run`. Graphs without routine nodes behave
exactly as before.

```json
{
  "node_type": "routine",
  "description": "owner-scoped trigger→action automation owned by a person — declarative when→do rules dispatching only the owner's agents, AND-ed with org policy",
  "prefix": [
    "routine-"
  ],
  "capturable": false
}
```
