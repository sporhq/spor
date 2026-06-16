---
id: schema-edge-owned-by
type: schema
kind: edge-schema
schema_version: 2026.06.16.1
title: Seed schema for owned-by edges
summary: Edge schema for the owned-by type — an agent is owned by a person; the identity-binding key for agent-on-behalf-of-person attribution. Structural membership like grouped-under, not a work dependency. Seed-pack default; a graph-resident schema node for this edge type overrides it.
date: 2026-06-16
---

Seed schema for the `owned-by` edge type (agent → person), shipped with the
plugin as a registry default (QUEUE.md §2). Written from a `type: agent` node
(schema-agent) to its owning `person-` node by `spor agent create` / the admin
endpoint, recording the person-owns-agent binding as a first-class graph fact
(dec-spor-agent-identity-nodes).

A low structural weight, mirroring `grouped-under` (0.3): like a repo's home
grouping, an agent's owner is durable membership, not work flow — the owner
rarely needs to be pulled into a work neighborhood, and a low weight keeps agent
identity from polluting task briefings. It sits just under the person-graph
identity edges (`stewards` 0.4, `assigned` 0.5), which DO carry work signal. Its
inverse `owns` is how the binding reads from the person's side (person owns
agent), flipped onto the person on write.

`capturable: false`: the binding is created deliberately alongside the agent
node (schema-agent), never drafted from a capture — mirroring the identity-node
types it joins.

```json
{
  "edge_type": "owned-by",
  "description": "this agent is owned by the target person — the agent-on-behalf-of-person identity binding",
  "weight": 0.3,
  "inverse_label": "owns",
  "capturable": false
}
```
