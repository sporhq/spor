---
id: schema-edge-assigned
type: schema
kind: edge-schema
schema_version: 2026.06.18.1
title: Seed schema for assigned edges
summary: Edge schema for the assigned type — work is assigned to a person OR an agent; the traversal key for per-person views and queues, and the orchestration layer's explicit-routing edge. An agent-targeted edge may carry an optional profile: attribute (the per-assignment profile override). Seed-pack default; a graph-resident schema node for this edge type overrides it.
date: 2026-06-18
---

Seed schema for the `assigned` edge type (work node → person OR agent), shipped
with the plugin as a registry default (QUEUE.md §2). Per-person views
("what am I blocking") traverse it from the `$viewer` binding; per-person
queues filter on it — the queue's `assignee` parameter
(`GET /v1/queue?assignee=<person>`), unioned with the person's `stewards`
edges (task-cc-queue-assignee-filtering).

**Routing is explicit assignment, not eligibility**
(dec-spor-agent-orchestration-layer). The target distinguishes who does the work:

- `assigned → person` — human work. Unassigned + person-assigned = today's human
  pool, unchanged.
- `assigned → agent-X` — an agent does it (X's profile says how and what it can
  touch). Only agent-assigned tasks are dispatch candidates. Use this for work an
  agent must NOT do — e.g. an irreversible real-world action — by assigning it to
  the person instead.

An agent-targeted edge may carry an optional **`profile:` attribute** — the
durable, graph-recorded per-assignment profile override
(dec-spor-orchestration-routine-requires-threads thread 3): `{type: assigned, to:
agent-X, profile: profile-Y}` reads "when this task goes to this agent, run it
under this profile." It is the natural, auditable home for the override; cascade
precedence is `--profile` dispatch flag > this assignment-edge attribute > the
agent's default `uses-profile` (schema-edge-uses-profile). The attribute is flat
edge data the regex frontmatter parser preserves; the dispatch matcher reads it
(task-spor-dispatch-capabilities-satisfiability). An assignment with no `profile:`
falls through to the agent's default, so existing `assigned` edges are unchanged
(backward-readable, no upgrade chain). Weight is unchanged at 0.5.

```json
{
  "edge_type": "assigned",
  "description": "work assigned to this person or agent — the explicit-routing edge; an agent target may carry a profile: per-assignment override",
  "weight": 0.5
}
```
