---
id: schema-edge-uses-profile
type: schema
kind: edge-schema
schema_version: 2026.06.18.1
title: Seed schema for uses-profile edges
summary: Edge schema for the uses-profile type — an agent → its DEFAULT profile (the runtime+capability bundle it dispatches under), overridable per assignment or per dispatch. A low-weight structural config binding like owned-by, not a work dependency. Seed-pack default; a graph-resident schema node for this edge type overrides it.
date: 2026-06-18
---

Seed schema for the `uses-profile` edge type (agent → profile), shipped with the
plugin as a registry default (QUEUE.md §2). Written from a `type: agent` node
(schema-agent) to the `profile-` node (schema-profile) it dispatches under by
default — "the WHO points at the HOW" (dec-spor-agent-orchestration-layer).

The default is overridable without rewriting this edge: per assignment via the
`assigned → agent` edge's `profile:` attribute (schema-edge-assigned), or per
dispatch via `--profile`. Cascade precedence, explicit wins: `--profile` flag >
assignment-edge attribute > this default `uses-profile`
(dec-spor-orchestration-routine-requires-threads thread 3) — the same shape as
`dispatch.agent` vs `--as`.

A low structural weight (0.3), mirroring `owned-by` and `grouped-under`: an
agent's default profile is durable configuration, not work flow — the profile
rarely needs to be pulled into a work neighborhood, and a low weight keeps
runtime config from polluting task briefings. `capturable: false`: the binding
is created deliberately alongside the agent/profile (by `spor agent` config),
never drafted from a capture — mirroring the identity/config-node family it joins
(`owned-by`).

```json
{
  "edge_type": "uses-profile",
  "description": "this agent's default profile — the runtime+capability bundle it dispatches under (overridable per assignment or dispatch)",
  "weight": 0.3,
  "capturable": false
}
```
