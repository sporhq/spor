---
id: schema-agent
type: schema
kind: node-schema
schema_version: 2026.06.16.1
title: Seed schema for agent nodes
summary: Node schema for the agent type — a person-owned automation principal (a dispatched Claude session's durable identity), owned by a person via an `owned-by` edge and carrying a forward-compat `spiffe:`/`pubkey:` shape. One persistent node per machine/install, reused across dispatches; its writes are attributed "agent on behalf of person", not as the person directly. Seed-pack default; a graph-resident schema node for this type overrides it.
date: 2026-06-16
---

Seed schema for the `agent` node type (ontology in GRAPH.md), shipped with the
plugin as a registry default (QUEUE.md §2). A `type: schema` node in the graph
with `kind: node-schema` and the same `node_type` overrides this entry.

An agent node makes a person's automation principal first-class instead of an
anonymous flag on a write (dec-spor-agent-identity-nodes). It generalizes the
workflow-run principal the graph already carries: an interactively dispatched
`claude --bg` session is just another principal kind owned by a person, so its
created nodes can read "agent on behalf of person" instead of person-direct.

**Grain: persistent + lightweight runs.** One durable agent node per
machine/install, created once (e.g. `agent-anthony-laptop`) by `spor agent
create`, and REUSED across dispatches — NOT one node per session. The Claude
Code `session_id` of each dispatch is the ephemeral which-run; it rides as an
additive `session:` stamp on created nodes, not its own node (promote to a
`run-<id>` node only if run metadata later needs a home).

**Ownership is an edge, not a field.** An agent's owner is recorded with an
`owned-by` edge → its `person-<id>` (schema-edge-owned-by), so the binding is a
first-class, traversable graph fact rather than a frontmatter scalar — the same
shape question routing and `$viewer` already key on for person edges. The
agent/person binding is authorization-load-bearing, so like all attribution
(dec-cc-attribution-from-token) it is asserted only by an authenticated
identity, never from a caller's payload.

Instances carry, beyond the standard fields (`id`, `type`, `title`, `summary`,
`date`), three identity registers — all flat scalars the regex frontmatter
parser already supports:

- `spiffe:` — a SPIFFE-shaped URI encoding the agent→person binding in its
  path: `spiffe://spor.<org>/person/<person-id>/agent/<label>`. The dispatch
  run extends it to the session leaf the workflow side already uses
  (`…/agent/<label>/session/<uuid>`). Adopted as forward-compat SHAPE
  (dec-cc-spiffe-forward-compat) — recorded, not yet runtime-verified.
- `pubkey:` — the agent's public-key fingerprint string. MAY BE EMPTY in this
  cut; recorded for forward-compat (server-token JWKS / local signed-commit
  web-of-trust) but UNENFORCED — no signature verification ships yet.
- `status: active` — an agent is live by default. Any other status (or none)
  reads as before; declarative data only, not gated by a `transitions()` enum,
  so it stays backward-readable.

`capturable: false`: agent identity is created deliberately (`spor agent
create`, or the admin endpoint), never drafted from a capture or a distilled
transcript — mirroring `person`, `repo`, and `workflow-run`. Graphs without
agent nodes behave exactly as before; their nodes simply lack the
`authored_by_agent`/`session` attribution stamps and read as person-direct.

```json
{
  "node_type": "agent",
  "description": "a person-owned automation principal — a dispatched session's durable identity, owned by a person via an owned-by edge; its writes are attributed agent-on-behalf-of-person",
  "prefix": [
    "agent-"
  ],
  "capturable": false
}
```
